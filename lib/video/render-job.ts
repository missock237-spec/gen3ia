import "server-only";

/**
 * GEN3IA VIDEO AGENT — CONTRAT DU JOB DE RENDU (module 19, partie 1,
 * extrait de render-queue.ts).
 *
 * Feuille partagée par la file (render-queue.ts) et les étapes de rendu
 * (render-stages.ts) : collection Firestore, pondérations de progression,
 * helpers de progression/normalisation, passage à l'étape suivante et
 * nettoyage tmp. Code déplacé tel quel — aucun changement de comportement.
 */

import { adminDb } from "@/lib/firebase/admin";
import { cleanupJob } from "@/lib/video/render/engine";
import type { RenderJob, RenderStage } from "@/lib/video/types";
import { writeCheckpointSet } from "@/lib/db/firestore-resilient";
import { computeStageProgress, clamp01, nowIso } from "@/lib/video/queue-core";
import { setJobProgress } from "@/lib/video/progress-store";

export const JOBS_COLLECTION = "videoRenderJobs";

export async function mirrorRenderProgress(job: Pick<RenderJob, "id" | "status" | "stage" | "progress">, extra?: Record<string, unknown>): Promise<void> {
  await setJobProgress(job.id, normalizeStoredProgress(job.progress), job.status, {
    stage: job.stage,
    ...extra,
  }).catch(() => undefined);
}

/**
 * Progression par étape — CONTRAT STOCKÉ 0..1 (Task 1-a FIX 4) :
 * [début d'étape, fin d'étape]. La cross-stage progress = stageStart +
 * stageWeight × withinStageRatio ; l'UI multiplie par 100.
 */
export const STAGE_PROGRESS: Record<RenderStage, [number, number]> = {
  plan: [0, 0.05],
  download: [0.05, 0.08],
  segments: [0.08, 0.73],
  transitions: [0.73, 0.78],
  audio: [0.78, 0.86],
  subtitles: [0.86, 0.9],
  qc: [0.9, 0.95],
  exports: [0.95, 0.99],
  finalize: [0.99, 1],
};

export const STAGE_ORDER: RenderStage[] = ["plan", "download", "segments", "transitions", "audio", "subtitles", "qc", "exports", "finalize"];

/** Budget de RELANCE après échec (distinct du compteur informatif `attempts`). */
export const RENDER_RETRY_BUDGET = 3;

/**
 * Progression globale d'un job (contrat 0..1, Task 1-a FIX 4) — utilisée
 * par TOUS les écrivains de progression. Pour `segments`/`exports`,
 * completedSegments/totalSegments interpole DANS l'étape ; pour les étapes
 * unitaires, totalSegments = 0 (progression = début d'étape) ; finalize = 1.
 */
export function computeJobProgress(stage: RenderStage, completedSegments: number, totalSegments: number): number {
  return computeStageProgress(STAGE_PROGRESS, "finalize", stage, completedSegments, totalSegments);
}

/** Normalise une progression héritée (anciens documents en 0..100 → 0..1). */
export function normalizeStoredProgress(progress: unknown): number {
  const value = typeof progress === "number" && Number.isFinite(progress) ? progress : 0;
  return value > 1 ? clamp01(value / 100) : clamp01(value);
}

async function moveToNextStage(jobId: string, job: RenderJob, fromStage: RenderStage): Promise<void> {
  const index = STAGE_ORDER.indexOf(fromStage);
  const next = STAGE_ORDER[Math.min(index + 1, STAGE_ORDER.length - 1)];
  // Task 95-c — écriture via la couche résiliente (checkpoint Task 106-fix).
  await writeCheckpointSet(
    JOBS_COLLECTION,
    jobId,
    { stage: next, progress: computeJobProgress(next, 0, 0), updatedAt: nowIso() },
    job.userId,
  );
  job.stage = next;
}

async function cleanupJobTmp(jobId: string): Promise<void> {
  const snap = await adminDb.collection(JOBS_COLLECTION).doc(jobId).get();
  if (!snap.exists) return;
  const job = snap.data() as RenderJob;
  await cleanupJob(job);
  await adminDb.collection(JOBS_COLLECTION).doc(jobId).set({ tmpDir: null }, { merge: true });
}

export { moveToNextStage, cleanupJobTmp };

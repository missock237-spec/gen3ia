import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 20 : Export Service (spec §23).
 *
 * Une seule production devient : MASTER 16:9 → YouTube 16:9, Shorts 9:16,
 * TikTok 9:16, Instagram Reels 9:16, Instagram 1:1, Facebook 16:9.
 *
 * Deux voies :
 * 1. cibles demandées AU MOMENT du rendu (paramètre derivedTargets) ;
 * 2. exports ADDITIONNELS après coup : un job `exports_only` re-part du
 *    master stocké (aucun re-rendu des segments), recadre et re-brûle des
 *    sous-titres adaptés (Shorts centrés/gras), sans re-facturer le master.
 */

import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import type { RenderJob, VideoExportTarget } from "@/lib/video/types";
import { getOwnedProjectOrThrow } from "@/lib/video/project-service";
import { JOBS_COLLECTION, getOwnedJobOrThrow, publishVideoTick } from "@/lib/video/render-queue";
import { reserveExportsBudget } from "@/lib/video/credits";

/** Coût symbolique des exports (encodage, stockage) — sans re-rendu. */
const EXPORT_MINOR_PER_TARGET = 40;

export interface StartExportResult {
  jobId: string;
  queued: boolean;
  targets: VideoExportTarget[];
}

/**
 * Demande des formats dérivés supplémentaires pour un rendu déjà terminé.
 * Le job hérite du plan du rendu d'origine (masterR2Key inclus).
 */
export async function startAdditionalExports(params: {
  userId: string;
  projectId: string;
  sourceJobId: string;
  targets: VideoExportTarget[];
  origin: string;
}): Promise<StartExportResult> {
  const project = await getOwnedProjectOrThrow(params.userId, params.projectId);
  const source = await getOwnedJobOrThrow(params.userId, params.sourceJobId);
  if (source.status !== "completed" || !source.output?.r2Key) {
    throw new Error("Le rendu source n'est pas terminé — attendez la fin ou relancez un rendu.");
  }
  if (!source.plan) throw new Error("Plan du rendu source introuvable.");
  const already = new Set(source.exports.filter((e) => e.status === "done").map((e) => e.target));
  const targets = params.targets.filter((t) => t !== "master_16_9" && !already.has(t));
  if (targets.length === 0) throw new Error("Tous ces formats ont déjà été exportés.");

  const jobId = randomUUID();
  const exportJob: RenderJob = {
    id: jobId,
    projectId: project.id,
    userId: params.userId,
    status: "queued",
    stage: "exports",
    progress: 0.95,
    plan: { ...source.plan, masterR2Key: source.output.r2Key },
    checkpoints: {
      downloadedAssetIds: [],
      completedSegments: source.plan.segments.map((s) => s.index),
      transitionPass: 0,
      transitionsDone: true,
      audioDone: true,
      subtitlesDone: true,
      qcDone: true,
      exportsDone: [],
    },
    mode: "exports_only",
    autoFixRounds: 0,
    attempts: 0,
    exports: targets.map((target) => ({ target, r2Key: "", sizeBytes: 0, status: "pending" })),
    billedMinor: targets.length * EXPORT_MINOR_PER_TARGET,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await adminDb.collection(JOBS_COLLECTION).doc(jobId).create({ ...exportJob });
  // Réservation réelle du budget exports (encodage + stockage, réglé à la livraison).
  await reserveExportsBudget(params.userId, jobId, targets.length * EXPORT_MINOR_PER_TARGET);
  await publishVideoTick(params.origin, jobId);
  return { jobId, queued: true, targets };
}

/**
 * Crée un « job tiktok » complet (version Shorts dédiée d'une production
 * existante) : réutilise le master + sous-titres Shorts — la commande
 * conversationnelle « Fais une version TikTok » passe par ici.
 */
export async function requestShortsVersion(params: {
  userId: string;
  projectId: string;
  origin: string;
}): Promise<StartExportResult | null> {
  const jobs = await adminDb.collection(JOBS_COLLECTION)
    .where("userId", "==", params.userId)
    .get();
  const completed = jobs.docs
    .map((d) => d.data() as RenderJob)
    .filter((j) => j.projectId === params.projectId && j.status === "completed" && j.mode !== "exports_only")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const source = completed[0];
  if (!source) return null;
  return startAdditionalExports({
    userId: params.userId,
    projectId: params.projectId,
    sourceJobId: source.id,
    targets: ["tiktok_9_16", "shorts_9_16", "reels_9_16"],
    origin: params.origin,
  });
}

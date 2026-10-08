import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 19 : Render Queue + orchestrateur de
 * production (spec §19).
 *
 * File de rendu avec états QUEUED/PROCESSING/PAUSED/FAILED/CANCELLED/
 * COMPLETED, étapes idempotentes, CHECKPOINTS (reprise au segment N après
 * un échec à 73 % — jamais de re-rendu complet), continuation arrière-plan
 * via QStash (le rendu survit aux fermetures d'onglets et aux échéances
 * serverless), annulation, pause/reprise, nettoyage du tmp, facturation
 * reserve→settle/release et notification de livraison.
 *
 * Task 1-a (rendu réellement fonctionnel) :
 * - publication QStash via le pattern partagé PATH BRUT → repli encodé
 *   (la build QStash du compte rejette les destinations encodées) avec
 *   résultat discriminé — plus aucun échec silencieux de continuation ;
 * - timeline matérialisée AU RENDU (lazy-init partagée avec la route GET,
 *   lib/video/timeline-bootstrap) — plus d'échec « Timeline absente » ;
 * - `attempts` = compteur informatif de ticks, `retryCount` = budget de
 *   relance après échec (un rendu de 40 ticks garde ses 3 relances) ;
 * - progression STOCKÉE unifiée en 0..1 (computeJobProgress) — l'UI
 *   multiplie par 100 sans jamais afficher 7300 % ;
 * - claim TRANSACTIONNEL avec bail (leaseOwner + leaseExpiresAt) — deux
 *   ticks/polls concurrents ne peuvent plus travailler le même job ;
 * - sweepStaleRenderJobs (bails expirés → reprise/échec propre) et
 *   maybeAdvancePendingJob (continuation par SONDAGE : le rendu avance
 *   même sans QStash tant que le studio est ouvert).
 */

import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import type {
  RenderJob,
  RenderJobStatus,
  RenderPlan,
  RenderStage,
  VideoAsset,
  SfxName,
  VideoExportTarget,
} from "@/lib/video/types";
import { getOwnedProjectOrThrow, logSystem, setProjectStatus } from "@/lib/video/project-service";
import { getAsset, listAssets } from "@/lib/video/asset-service";
import { buildRenderPlan, buildAssForRender, buildShortsAss, renderDimensions } from "@/lib/video/render/planner";
import {
  renderSegments,
  assembleTransitions,
  mixAudio,
  finalizeMaster,
  renderExportFormat,
  uploadMaster,
  cleanupJob,
  createJobTmpDir,
  type EngineIo,
} from "@/lib/video/render/engine";
import { materializeForRender, uploadVideoAsset } from "@/lib/video/storage";
import { analyzeRenderedMaster, decideAutoFix } from "@/lib/video/qc-service";
import { estimateRenderCost, reserveRenderBudget, settleRenderBudget, releaseRenderBudget, settleExportsBudget } from "@/lib/video/credits";
import { assembleRecursive } from "@/lib/video/long-video-service";
import { VIDEO_LIMITS, VideoQuotaError, MAX_AUTO_FIX_ROUNDS } from "@/lib/video/security";
import { createNotification } from "@/lib/notifications/repository";
import { ensureAudioAssetsForProject } from "@/lib/video/audio-engine";
import { publishJsonDestination, type QStashPublishResult } from "@/lib/queue/qstash";
import { resolveJobOrigin } from "@/lib/queue/origin";
import { ensureProjectTimeline } from "@/lib/video/timeline-bootstrap";
import { setJobProgress } from "@/lib/video/progress-store";
import { logger } from "@/lib/observability/logger";
import {
  classifyTickError,
  createJobDoc,
  loadJobDoc,
  queryJobDocs,
  resumePolicyFor,
  type RenderJobWithResume,
  type ResumePolicy,
} from "@/lib/video/queue-resume";
import { firestoreUsable, writeCheckpointSet } from "@/lib/db/firestore-resilient";

export const JOBS_COLLECTION = "videoRenderJobs";
async function mirrorRenderProgress(job: Pick<RenderJob, "id" | "status" | "stage" | "progress">, extra?: Record<string, unknown>): Promise<void> {
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
const STAGE_PROGRESS: Record<RenderStage, [number, number]> = {
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

const STAGE_ORDER: RenderStage[] = ["plan", "download", "segments", "transitions", "audio", "subtitles", "qc", "exports", "finalize"];

/** Budget de RELANCE après échec (distinct du compteur informatif `attempts`). */
export const RENDER_RETRY_BUDGET = 3;

/** Segments rendus par tick (bornage serverless — le reste via continuation). */
const MAX_SEGMENTS_PER_TICK = 3;
/** Échéance d'un tick au-delà de laquelle on re-file le job (continuation). */
const TICK_DEADLINE_MS = 230_000;
/** Budget de travail par défaut d'une avance « sondage » (route GET responsive). */
export const POLL_ADVANCE_BUDGET_MS = 55_000;

function nowIso(): string {
  return new Date().toISOString();
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 10_000) / 10_000));
}

/**
 * Progression globale d'un job (contrat 0..1, Task 1-a FIX 4) — utilisée
 * par TOUS les écrivains de progression. Pour `segments`/`exports`,
 * completedSegments/totalSegments interpole DANS l'étape ; pour les étapes
 * unitaires, totalSegments = 0 (progression = début d'étape) ; finalize = 1.
 */
export function computeJobProgress(stage: RenderStage, completedSegments: number, totalSegments: number): number {
  const [start, end] = STAGE_PROGRESS[stage];
  const span = end - start;
  const safeTotal = Math.max(0, totalSegments);
  const ratio = safeTotal > 0
    ? Math.min(1, Math.max(0, completedSegments / safeTotal))
    : stage === "finalize"
      ? 1
      : 0;
  return clamp01(start + span * ratio);
}

/** Normalise une progression héritée (anciens documents en 0..100 → 0..1). */
function normalizeStoredProgress(progress: unknown): number {
  const value = typeof progress === "number" && Number.isFinite(progress) ? progress : 0;
  return value > 1 ? clamp01(value / 100) : clamp01(value);
}

// ────────────────────────────────────────────────────────────────────────────
// Démarrage d'un rendu
// ────────────────────────────────────────────────────────────────────────────

export async function startRenderJob(params: {
  userId: string;
  projectId: string;
  derivedTargets: VideoExportTarget[];
}): Promise<{ jobId: string; queued: boolean; estimate: ReturnType<typeof estimateRenderCost> }> {
  const project = await getOwnedProjectOrThrow(params.userId, params.projectId);
  if (!project.script || project.script.scenes.length === 0) {
    throw new Error("Aucun scénario à monter — générez d'abord le scénario.");
  }
  const images = await listAssets(params.userId, params.projectId, "image");
  const sceneImages = images.filter((a) => a.role?.startsWith("scene:"));
  if (sceneImages.length === 0) {
    throw new Error("Aucune image de scène — générez d'abord les visuels (generate-assets).");
  }

  // Limite de rendus concurrents.
  const running = await countRunningRenders(params.userId);
  if (running >= VIDEO_LIMITS.maxConcurrentRenders) {
    throw new VideoQuotaError(`Vous avez déjà ${running} rendu(s) en cours (limite ${VIDEO_LIMITS.maxConcurrentRenders}). Pausez-en un ou attendez la fin.`);
  }

  const expectedSec = project.script.estimatedDurationSec || project.targetDurationSec;
  const estimate = estimateRenderCost({ durationSec: expectedSec, resolution: project.resolution });
  const jobId = randomUUID();

  // Réservation du budget (fail-closed si solde insuffisant).
  await reserveRenderBudget(params.userId, jobId, estimate);

  const job: RenderJob = {
    id: jobId,
    projectId: params.projectId,
    userId: params.userId,
    status: "queued",
    stage: "plan",
    progress: 0,
    checkpoints: {
      downloadedAssetIds: [],
      completedSegments: [],
      transitionPass: 0,
      transitionsDone: false,
      audioDone: false,
      subtitlesDone: false,
      qcDone: false,
      exportsDone: [],
    },
    mode: "full",
    autoFixRounds: 0,
    attempts: 0,
    retryCount: 0,
    exports: params.derivedTargets.map((target) => ({ target, r2Key: "", sizeBytes: 0, status: "pending" })),
    billedMinor: estimate.amountMinor,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  // Task 95-c — création via la couche résiliente (Firestore unique moteur, Task 108)
  // + COMPENSATION : si la création échoue (quota Firestore par exemple),
  // la réservation wallet est remboursée avant de propager — jamais de
  // réservation orpheline sans job.
  try {
    await createJobDoc(JOBS_COLLECTION, jobId, { ...job }, params.userId);
  } catch (error) {
    await releaseRenderBudget(params.userId, jobId, estimate.amountMinor).catch(() => undefined);
    if (classifyTickError(error) === "quota") {
      throw new Error(
        "Quota Firestore épuisé au lancement du rendu — réservation remboursée, réessayez ou laissez la reprise automatique retenter.",
      );
    }
    throw error;
  }
  await mirrorRenderProgress(job, { projectId: job.projectId });
  await setProjectStatus(params.userId, params.projectId, "rendering");
  await logSystem(params.projectId, `Rendu ${jobId.slice(0, 8)} mis en file (estimation ${estimate.amountMinor} minor, ${Math.round(expectedSec)} s).`);
  // ORIGINE CANONIQUE (fix CodeQL request-forgery) : publishVideoTick résout
  // GEN3IA_APP_ORIGIN en interne (allowlist serveur) — aucune origine requête.
  const published = await publishVideoTick(jobId);
  if (!published.ok) {
    // PAS d'échec bloquant : la continuation par sondage (GET render) et le
    // sweeper prennent le relais — mais l'incident est journalisé.
    if (published.mode === "error") {
      await logSystem(params.projectId, `Continuation QStash indisponible (${published.message.slice(0, 200)}) — le rendu avancera par sondage du studio ou worker local.`);
    }
  }
  return { jobId, queued: true, estimate };
}

async function countRunningRenders(userId: string): Promise<number> {
  const snap = await adminDb.collection(JOBS_COLLECTION).where("userId", "==", userId).get();
  return snap.docs.filter((d) => {
    const s = d.data()?.status;
    return s === "processing" || s === "queued";
  }).length;
}

// ────────────────────────────────────────────────────────────────────────────
// Publication QStash (continuation arrière-plan) — Task 1-a FIX 1
// ────────────────────────────────────────────────────────────────────────────

export function videoTickUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/video/worker/tick`;
}

/**
 * Publie un tick de rendu via le pattern partagé de lib/queue/qstash :
 * PATH BRUT primaire (la build QStash du compte rejette les destinations
 * URL-encodées — 400 « invalid destination url ») + repli encodé pour les
 * builds historiques. ORIGINE CANONIQUE (fix CodeQL request-forgery) :
 * résolue en interne depuis GEN3IA_APP_ORIGIN (allowlist serveur) — jamais
 * depuis une origine de requête. Retourne un résultat DISCRIMINÉ :
 * « unconfigured » couvre QStash absent ET origine non résolue (la
 * continuation par sondage prend le relais), « error » est à journaliser
 * (jamais de fantôme « queued »).
 */
export async function publishVideoTick(jobId: string, delaySeconds = 1): Promise<QStashPublishResult> {
  const resolved = resolveJobOrigin();
  if (!resolved.ok) return { ok: false, mode: "unconfigured" } as const;
  return publishJsonDestination(videoTickUrl(resolved.origin), JSON.stringify({ jobId }), { delaySeconds });
}

/**
 * Publication interne : renvoie true si le tick est enfilé ; journalise
 * les échecs RÉELS (mode error) — le mode unconfigured (QStash absent ou
 * origine canonique non résolue) est le fonctionnement normal en
 * environnement sans file (continuation par sondage).
 */
async function publishTickAndLog(job: Pick<RenderJob, "id" | "projectId">, delaySeconds = 0): Promise<boolean> {
  const published = await publishVideoTick(job.id, delaySeconds);
  if (!published.ok && published.mode === "error") {
    await logSystem(job.projectId, `Continuation QStash échouée (${published.message.slice(0, 200)}) — reprise par sondage du studio ou worker local.`).catch(() => undefined);
  }
  return published.ok;
}

/** Reprise : remet un job en file et le re-file (utilisateur ou worker). */
export async function resumeJob(userId: string, jobId: string): Promise<void> {
  const job = await getOwnedJobOrThrow(userId, jobId);
  if (job.status !== "paused" && job.status !== "failed" && job.status !== "cancelled") {
    throw new Error(`Reprise impossible depuis l'état ${job.status}.`);
  }
  await adminDb.collection(JOBS_COLLECTION).doc(jobId).set(
    {
      status: "queued",
      errorMessage: null,
      errorCode: null,
      attempts: FieldValue.increment(1),
      // Reprise explicite = nouvelle intention utilisateur : budget de
      // relance restauré (les erreurs passées ne comptent plus).
      retryCount: 0,
      leaseOwner: FieldValue.delete(),
      leaseExpiresAt: 0,
      updatedAt: nowIso(),
    },
    { merge: true },
  );
  await publishTickAndLog(job);
}

export async function pauseJob(userId: string, jobId: string): Promise<void> {
  const job = await getOwnedJobOrThrow(userId, jobId);
  if (job.status !== "processing" && job.status !== "queued") throw new Error(`Pause impossible depuis l'état ${job.status}.`);
  await adminDb.collection(JOBS_COLLECTION).doc(jobId).set(
    { status: "paused", leaseOwner: FieldValue.delete(), leaseExpiresAt: 0, updatedAt: nowIso() },
    { merge: true },
  );
}

export async function cancelJob(userId: string, jobId: string): Promise<void> {
  const job = await getOwnedJobOrThrow(userId, jobId);
  if (job.status === "completed") throw new Error("Rendu déjà terminé.");
  await adminDb.collection(JOBS_COLLECTION).doc(jobId).set({ status: "cancelled", updatedAt: nowIso() }, { merge: true });
  if (job.billedMinor > 0) {
    await releaseRenderBudget(job.userId, job.id, job.billedMinor).catch(() => undefined);
    await adminDb.collection(JOBS_COLLECTION).doc(jobId).set({ billedMinor: 0 }, { merge: true });
  }
  await cleanupJobTmp(jobId);
  await setProjectStatus(userId, job.projectId, "storyboarded").catch(() => undefined);
  await logSystem(job.projectId, `Rendu ${jobId.slice(0, 8)} annulé — réservation libérée.`);
}

export async function listJobs(userId: string, projectId?: string): Promise<RenderJob[]> {
  const snap = await adminDb.collection(JOBS_COLLECTION).where("userId", "==", userId).get();
  const jobs = snap.docs
    .map((d) => {
      const job = d.data() as RenderJob;
      // Compatibilité champs : les documents antérieurs stockaient 0..100.
      job.progress = normalizeStoredProgress(job.progress);
      return job;
    })
    .filter((j) => !projectId || j.projectId === projectId);
  jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return jobs;
}

export async function getOwnedJobOrThrow(userId: string, jobId: string): Promise<RenderJob> {
  const snap = await adminDb.collection(JOBS_COLLECTION).doc(jobId).get();
  if (!snap.exists) throw new Error("Rendu introuvable.");
  const job = snap.data() as RenderJob;
  if (job.userId !== userId) throw new Error("Rendu introuvable.");
  return job;
}

async function cleanupJobTmp(jobId: string): Promise<void> {
  const snap = await adminDb.collection(JOBS_COLLECTION).doc(jobId).get();
  if (!snap.exists) return;
  const job = snap.data() as RenderJob;
  await cleanupJob(job);
  await adminDb.collection(JOBS_COLLECTION).doc(jobId).set({ tmpDir: null }, { merge: true });
}

// ────────────────────────────────────────────────────────────────────────────
// Machine d'étapes — un tick avance d'une étape (ou d'un lot de segments)
// ────────────────────────────────────────────────────────────────────────────

export interface TickResult {
  jobId: string;
  status: RenderJobStatus;
  stage: RenderStage | null;
  done: boolean;
  continued: boolean;
  message: string;
}

/**
 * Résultat d'exécution d'une étape : le publishing du tick suivant et la
 * libération du bail restent sous le contrôle de advanceJob — ordre garanti
 * « bail libéré AVANT re-file » (sinon le tick suivant arriverait sur un
 * bail encore actif et serait no-op jusqu'à son expiration).
 */
type StageOutcome =
  | { kind: "next" }
  | { kind: "continue"; stage: RenderStage; message: string; delaySeconds?: number }
  | { kind: "terminal"; result: TickResult };

// ────────────────────────────────────────────────────────────────────────────
// Claim transactionnel + bail (Task 1-a FIX 5d)
// ────────────────────────────────────────────────────────────────────────────

type ClaimOutcome =
  | { kind: "claimed"; job: RenderJob }
  | { kind: "missing" }
  | { kind: "terminal"; job: RenderJob }
  | { kind: "lease-held"; job: RenderJob };

function leaseActive(job: RenderJob, now: number): boolean {
  return typeof job.leaseExpiresAt === "number" && job.leaseExpiresAt > now;
}

/**
 * Prise de possession ATOMIQUE (transaction Firestore) : lit le statut ET
 * pose le bail dans le même commit — deux ticks / deux polls concurrents
 * ne peuvent pas tous deux « claimed ». Un statut terminal est un no-op
 * (redélivrance QStash après complétion), un bail vivant aussi.
 */
async function claimJobForTick(jobId: string): Promise<ClaimOutcome> {
  // Task 106-fix / Task 108 — COHÉRENCE DE RÉGIME : si le disjoncteur quota
  // Firestore est OUVERT, les checkpoints d'étape (saveJobDoc) échouent en
  // erreur quota-classifiée — un claim transactionnel qui réussirait encore
  // relirait l'ancien document Firestore (checkpoints absents) et
  // re-rendrait les mêmes segments à l'infini (constaté en production,
  // Task 106). Le claim renonce DONC aussi (erreur quota-classifiée : le
  // tick est republié avec délai, la reprise se fait après cooldown).
  if (!firestoreUsable()) {
    throw new Error(`Claim impossible : quota Firestore (disjoncteur ouvert) pour ${jobId} — tick reporté.`);
  }
  // Task 95-c — le claim reste TRANSACTIONNEL sur Firestore. Une erreur de
  // QUOTA est propagée telle quelle (Task 108 : plus de failover miroir) —
  // transitoire/fatal : propagation inchangée.
  return adminDb.runTransaction(async (tx) => {
    const ref = adminDb.collection(JOBS_COLLECTION).doc(jobId);
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return { kind: "missing" } as const;
    const stored = snapshot.data() as RenderJob;
    if (!stored) return { kind: "missing" } as const;
    const job: RenderJob = {
      ...stored,
      // Compatibilité champs : documents antérieurs sans ces champs.
      attempts: typeof stored.attempts === "number" ? stored.attempts : 0,
      retryCount: typeof stored.retryCount === "number" ? stored.retryCount : 0,
      progress: normalizeStoredProgress(stored.progress),
      checkpoints: stored.checkpoints ?? {
        downloadedAssetIds: [],
        completedSegments: [],
        transitionPass: 0,
        transitionsDone: false,
        audioDone: false,
        subtitlesDone: false,
        qcDone: false,
        exportsDone: [],
      },
      exports: Array.isArray(stored.exports) ? stored.exports : [],
      billedMinor: typeof stored.billedMinor === "number" ? stored.billedMinor : 0,
    };
    if (job.status === "paused" || job.status === "cancelled" || job.status === "completed" || job.status === "failed") {
      return { kind: "terminal", job } as const;
    }
    const now = Date.now();
    if (job.status === "processing" && leaseActive(job, now)) {
      return { kind: "lease-held", job } as const;
    }
    const leaseOwner = `${jobId}:${randomUUID()}`;
    const leaseExpiresAt = now + TICK_DEADLINE_MS;
    tx.update(ref, {
      status: "processing",
      leaseOwner,
      leaseExpiresAt,
      deadlineAt: new Date(leaseExpiresAt).toISOString(),
      attempts: job.attempts + 1,
      updatedAt: nowIso(),
    });
    return {
      kind: "claimed",
      job: { ...job, status: "processing", leaseOwner, leaseExpiresAt, deadlineAt: new Date(leaseExpiresAt).toISOString(), attempts: job.attempts + 1 },
    } as const;
  });
}

/** Libère le bail en fin de tick réussi — le tick suivant peut claimr aussitôt. */
async function releaseLease(jobId: string): Promise<void> {
  await adminDb.collection(JOBS_COLLECTION).doc(jobId).set(
    { leaseOwner: FieldValue.delete(), leaseExpiresAt: 0, updatedAt: nowIso() },
    { merge: true },
  ).catch(() => undefined);
}

/**
 * Fait avancer un job d'une étape. Idempotent : chaque étape vérifie ses
 * checkpoints. En fin d'échéance (ou après MAX_SEGMENTS_PER_TICK), re-file
 * un tick QStash (continuation) — le rendu ne dépend d'aucun onglet ouvert.
 *
 * `options.timeBudgetMs` (continuation par sondage, Task 1-a FIX 5b) borne
 * le travail DANS l'étape segments : l'échéance est vérifiée entre chaque
 * segment, un checkpoint est écrit après chacun — le poll reste responsive.
 */
export async function advanceJob(jobId: string, options: { timeBudgetMs?: number } = {}): Promise<TickResult> {
  const outcome = await claimJobForTick(jobId);
  if (outcome.kind === "missing") {
    return { jobId, status: "failed", stage: null, done: true, continued: false, message: "Job introuvable." };
  }
  if (outcome.kind === "lease-held") {
    return { jobId, status: outcome.job.status, stage: outcome.job.stage, done: false, continued: false, message: "Tick déjà pris en charge par un autre worker (bail actif)." };
  }
  if (outcome.kind === "terminal") {
    const job = outcome.job;
    if (job.status === "cancelled" || job.status === "paused") {
      return { jobId, status: job.status, stage: job.stage, done: true, continued: false, message: `Job ${job.status}.` };
    }
    if (job.status === "completed") {
      return { jobId, status: job.status, stage: job.stage, done: true, continued: false, message: "Déjà terminé." };
    }
    return { jobId, status: job.status, stage: job.stage, done: true, continued: false, message: job.errorMessage ?? "Échec." };
  }

  const job = outcome.job;
  // Jobs d'EXPORT SEUL : sautent la production, démarrent à l'étape exports.
  if (job.mode === "exports_only" && STAGE_ORDER.indexOf(job.stage) < STAGE_ORDER.indexOf("exports")) {
    await adminDb.collection(JOBS_COLLECTION).doc(jobId).set({ stage: "exports", updatedAt: nowIso() }, { merge: true });
    job.stage = "exports";
  }
  const tmpDir = job.tmpDir ?? (await createJobTmpDir(jobId));
  if (tmpDir !== job.tmpDir) {
    await adminDb.collection(JOBS_COLLECTION).doc(jobId).set({ tmpDir, updatedAt: nowIso() }, { merge: true });
    job.tmpDir = tmpDir;
  }

  // Reprise cross-instance : /tmp est LOCAL à chaque instance lambda. Si le
  // répertoire du job n'existe pas SUR CETTE INSTANCE, aucun fichier
  // intermédiaire (segments, video_noaudio, audio_final, master) n'est
  // disponible — un tick au-delà de « segments » échouerait avec un ffmpeg
  // code 1 (entrées absentes) et consommerait le budget de relance. Rollback
  // déterministe : les images sont re-téléchargées depuis R2 et le rendu
  // repart du début des segments (checkpoints remis à zéro).
  if (!(await pathExists(tmpDir))) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(tmpDir, { recursive: true });
    if (
      job.mode !== "exports_only" &&
      STAGE_ORDER.indexOf(job.stage) > STAGE_ORDER.indexOf("segments")
    ) {
      await resetToSegments(jobId, job, "instance relais sans fichiers temporaires");
    }
  }

  const io = buildEngineIo(job, tmpDir);
  const startedStage = job.stage;

  try {
    let outcome: StageOutcome;
    switch (job.stage) {
      case "plan":
        await stagePlan(job, io);
        outcome = { kind: "next" } as const;
        break;
      case "download":
        await stageDownload(job, io);
        outcome = { kind: "next" } as const;
        break;
      case "segments":
        outcome = await stageSegments(job, io, options.timeBudgetMs);
        break;
      case "transitions":
        outcome = await stageTransitions(job, io);
        break;
      case "audio":
        await stageAudio(job, io);
        outcome = { kind: "next" } as const;
        break;
      case "subtitles":
        await stageSubtitles(job);
        outcome = { kind: "next" } as const;
        break;
      case "qc":
        outcome = await stageQc(job, io);
        break;
      case "exports":
        outcome = await stageExports(job, io);
        break;
      case "finalize":
        outcome = await stageFinalize(job, io);
        break;
      default: {
        const exhaustive: never = job.stage;
        throw new Error(`Étape inconnue : ${String(exhaustive)}`);
      }
    }

    if (outcome.kind === "terminal") {
      // Statut final écrit par l'étape (finalize) — bail déjà libéré par elle.
      return outcome.result;
    }
    // Le travail de CE tick est terminé : bail libéré AVANT toute re-file
    // (le tick suivant — QStash ou sondage — doit pouvoir claimr aussitôt).
    await releaseLease(jobId);
    if (outcome.kind === "next") {
      await moveToNextStage(jobId, job, startedStage);
      const deadlineSoon = Date.now() + 30_000 > Date.parse(job.deadlineAt ?? "0");
      const enqueued = await publishTickAndLog(job, deadlineSoon ? 1 : 0);
      const refreshed = await refreshJob(jobId);
      return { jobId, status: refreshed.status, stage: refreshed.stage, done: false, continued: enqueued, message: `Étape ${startedStage} terminée.` };
    }
    const enqueued = await publishTickAndLog(job, outcome.delaySeconds ?? 0);
    const refreshed = await refreshJob(jobId);
    await mirrorRenderProgress(refreshed, { projectId: refreshed.projectId });
    return { jobId, status: refreshed.status, stage: refreshed.stage, done: false, continued: enqueued, message: outcome.message };
  } catch (error) {
    // Task 95-c — une erreur de QUOTA n'est pas un échec de rendu : elle ne
    // consomme PAS le budget de relance, ne marque JAMAIS failed et ne
    // notifie pas l'utilisateur. `quotaFailures` alimente le backoff.
    const klass = classifyTickError(error);
    const jobWithResume = job as RenderJobWithResume;
    const quotaFailures =
      klass === "quota"
        ? (typeof jobWithResume.quotaFailures === "number" ? jobWithResume.quotaFailures : 0) + 1
        : 0;
    const policy = resumePolicyFor(error, quotaFailures);
    // failJob reçoit la politique : quota/transitoire ne consomment PAS le
    // budget, ne marquent JAMAIS failed, ne notifient PAS. (failJob peut
    // propager si la ré-écriture échoue aussi (quota) — la route tick
    // republiera.)
    const result = await failJob(job, error instanceof Error ? error : new Error(String(error)), policy, quotaFailures);
    await mirrorRenderProgress({ ...job, status: result.status, progress: job.progress }, { projectId: job.projectId, error: result.message });
    return result;
  }
}

async function refreshJob(jobId: string): Promise<RenderJob> {
  // Task 95-c — lecture via la couche résiliente (Firestore unique moteur).
  const job = await loadJobDoc<RenderJob>(JOBS_COLLECTION, jobId);
  if (!job) throw new Error("Job introuvable au rafraîchissement du tick.");
  job.progress = normalizeStoredProgress(job.progress);
  return job;
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

/**
 * Échec d'un tick — DEUX régimes (Task 95-c) :
 *
 * 1. AVEC politique de reprise non consommatrice (`policy.consumeRetry`
 *    false — quota Firestore ou incident transitoire) : le budget
 *    `retryCount` N'EST PAS touché, le job repasse en file avec
 *    `nextAttemptAt` (backoff) et `quotaFailures` (compteur dédié). JAMAIS
 *    d'échec définitif, JAMAIS de notification utilisateur, JAMAIS de
 *    libération de réservation — la reprise se fait au dernier checkpoint.
 * 2. SANS politique ou politique fatale (legacy) : budget de relance =
 *    `retryCount` (Task 1-a FIX 3) — JAMAIS `attempts` (compteur
 *    informatif de ticks). Sous le budget : re-file avec délai ; au-delà :
 *    échec définitif, réservation libérée, purge, notification.
 *
 * Toute la fonction est protégée : si la RÉ-ÉCRITURE elle-même échoue
 * (quota aussi sur la ré-écriture), on journalise et on
 * PROPAGE — le catch de la route tick ré-enfilera le tick.
 */
async function failJob(job: RenderJob, error: Error, policy?: ResumePolicy, quotaFailures?: number): Promise<TickResult> {
  const message = error.message.slice(0, 800);
  // Observabilité production : le stderr capté par le runner FFmpeg (FfmpegError)
  // est la seule preuve du pourquoi d'un code 1 — il accompagne désormais tout
  // message d'échec persisté (borne 1200 caractères) + trace console (Sentry).
  const rawStderr = (error as { stderr?: unknown }).stderr;
  const stderrTail = typeof rawStderr === "string" && rawStderr.trim().length > 0
    ? rawStderr.trim().slice(-1200)
    : "";
  const messageWithStderr = stderrTail ? `${message} | stderr: ${stderrTail}` : message;
  if (stderrTail) {
    console.error(`[video-render] job=${job.id} stage=${job.stage} stderr=${stderrTail}`);
  }
  // Régime « reprise » : politique fournie et budget NON consommé (quota /
  // transitoire). Une politique fatale retombe dans le régime legacy.
  const resumeMode = policy ? !policy.consumeRetry : false;
  try {
    if (resumeMode && policy) {
      const isQuota = classifyTickError(error) === "quota";
      // Message stocké actionnable : pour un quota, pas d'alarme utilisateur.
      const storedMessage = isQuota
        ? `Quota Firestore épuisé — reprise automatique programmée (backoff ${policy.delaySeconds} s).`
        : messageWithStderr;
      const patch: Record<string, unknown> = {
        status: "queued",
        errorMessage: storedMessage,
        leaseOwner: FieldValue.delete(),
        leaseExpiresAt: 0,
        nextAttemptAt: new Date(Date.now() + policy.delaySeconds * 1000).toISOString(),
        updatedAt: nowIso(),
      };
      if (isQuota && typeof quotaFailures === "number" && quotaFailures > 0) {
        // Compteur d'incidents quota consécutifs (n'alimente PAS retryCount).
        patch.quotaFailures = quotaFailures;
      }
      await writeCheckpointSet(JOBS_COLLECTION, job.id, patch, job.userId);
      // publishTickAndLog retourne la réussite RÉELLE du publish — le champ
      // « continued » reflète l'honnêteté du ré-enfilement (faux = sondage
      // en relais) au lieu de dériver d'un simple paramètre non vide.
      const enqueued = await publishTickAndLog(job, policy.delaySeconds);
      await logSystem(
        job.projectId,
        `Rendu ${job.id.slice(0, 8)} : incident ${isQuota ? "quota Firestore" : "transitoire"} à l'étape ${job.stage} — reprise automatique dans ${policy.delaySeconds} s (budget de relance intact, checkpoints conservés).`,
      ).catch(() => undefined);
      return { jobId: job.id, status: "queued", stage: job.stage, done: false, continued: enqueued, message: storedMessage };
    }
    const retryCount = typeof job.retryCount === "number" ? job.retryCount : 0;
    // Reprise automatique : jusqu'à RENDER_RETRY_BUDGET relances (crash transitoire).
    if (retryCount < RENDER_RETRY_BUDGET) {
      await writeCheckpointSet(
        JOBS_COLLECTION,
        job.id,
        {
          status: "queued",
          errorMessage: messageWithStderr,
          retryCount: FieldValue.increment(1),
          leaseOwner: FieldValue.delete(),
          leaseExpiresAt: 0,
          updatedAt: nowIso(),
        },
        job.userId,
      );
      const enqueued = await publishTickAndLog(job, 15);
      await logSystem(job.projectId, `Rendu ${job.id.slice(0, 8)} : incident à l'étape ${job.stage} (relance ${retryCount + 1}/${RENDER_RETRY_BUDGET}) — reprise automatique au dernier checkpoint. ${message}`).catch(() => undefined);
      return { jobId: job.id, status: "queued", stage: job.stage, done: false, continued: enqueued, message };
    }
    // Échec définitif : libère la réservation, purge, notifie.
    await writeCheckpointSet(
      JOBS_COLLECTION,
      job.id,
      {
        status: "failed",
        errorCode: "RENDER_FAILED",
        errorMessage: messageWithStderr.slice(0, 2000),
        leaseOwner: FieldValue.delete(),
        leaseExpiresAt: 0,
        updatedAt: nowIso(),
      },
      job.userId,
    );
    if (job.billedMinor > 0) {
      await releaseRenderBudget(job.userId, job.id, job.billedMinor).catch(() => undefined);
      await writeCheckpointSet(JOBS_COLLECTION, job.id, { billedMinor: 0 }, job.userId);
    }
    await cleanupJobTmp(job.id);
    await setProjectStatus(job.userId, job.projectId, "failed").catch(() => undefined);
    await logSystem(job.projectId, `Rendu ${job.id.slice(0, 8)} ÉCHOUÉ à l'étape ${job.stage} : ${message} Réservation libérée.`).catch(() => undefined);
    await createNotification({
      userId: job.userId,
      type: "info",
      title: "Rendu vidéo échoué",
      body: `Le rendu a échoué (${job.stage}). Aucun montant débité — reprise possible depuis le studio vidéo.`,
    }).catch(() => undefined);
    return { jobId: job.id, status: "failed", stage: job.stage, done: true, continued: false, message: messageWithStderr };
  } catch (requeueError) {
    // La ré-écriture elle-même a échoué (quota aussi sur la ré-écriture) :
    // on journalise et on PROPAGE — la route tick ré-enfilera
    // avec délai ; aucun budget consommé côté job.
    logger.warn(
      { jobId: job.id, stage: job.stage, error: requeueError instanceof Error ? requeueError.message : String(requeueError) },
      "fail_job_requeue_failed",
    );
    throw requeueError;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Sweeper + continuation par sondage (Task 1-a FIX 5)
// ────────────────────────────────────────────────────────────────────────────

export interface SweepResult {
  scanned: number;
  requeued: number;
  failed: number;
}

/**
 * Récupère les jobs « processing » dont le bail/échéance est DÉPASSÉ
 * (worker tué par la plateforme, tick perdu) : failJob gère la reprise
 * (status queued + checkpoints conservés + relance) selon le budget
 * retryCount, ou l'échec définitif avec libération des fonds. Idempotent :
 * un job vivant (bail actif ou échéance future) n'est jamais touché.
 */
export async function sweepStaleRenderJobs(): Promise<SweepResult> {
  // Task 95-c — lecture via la couche résiliente (miroir chaud sous quota).
  const stale = await queryJobDocs<RenderJob>(JOBS_COLLECTION, "status", "processing");
  const now = Date.now();
  let requeued = 0;
  let failed = 0;
  for (const stored of stale) {
    const job: RenderJob = {
      ...stored,
      attempts: typeof stored.attempts === "number" ? stored.attempts : 0,
      retryCount: typeof stored.retryCount === "number" ? stored.retryCount : 0,
      progress: normalizeStoredProgress(stored.progress),
      billedMinor: typeof stored.billedMinor === "number" ? stored.billedMinor : 0,
    };
    if (leaseActive(job, now)) continue;
    const deadlineAt = job.deadlineAt ? Date.parse(job.deadlineAt) : Number.NaN;
    // Sans marqueur d'échéance (document historique), on ne juge pas.
    if (!Number.isFinite(deadlineAt) || deadlineAt > now) continue;
    const result = await failJob(job, new Error("Échéance de traitement dépassée (worker interrompu) — reprise au dernier checkpoint."));
    if (result.status === "queued") requeued += 1;
    else failed += 1;
  }
  return { scanned: stale.length, requeued, failed };
}

/**
 * Continuation par SONDAGE (Task 1-a FIX 5b) : fait avancer d'UN tick un
 * job en attente DANS la requête de polling (GET render) — le rendu avance
 * même quand QStash n'est pas configuré ou qu'un publish échoue, tant que
 * le studio reste ouvert. Le claim transactionnel garantit qu'un sondage
 * concurrent ne peut pas doubler un tick QStash (bail). Ne fait rien si le
 * job est terminal, en pause ou détenu par un worker vivant.
 */
export async function maybeAdvancePendingJob(jobId: string, options: { timeBudgetMs?: number } = {}): Promise<TickResult | null> {
  const job = await getJob(jobId);
  if (!job) return null;
  const now = Date.now();
  if (job.status === "queued") {
    return advanceJob(jobId, { timeBudgetMs: options.timeBudgetMs });
  }
  if (job.status === "processing" && !leaseActive(job, now)) {
    // Bail expiré (ou absent) : récupérable — le claim transactionnel
    // arbitre si un autre worker vient de le prendre.
    return advanceJob(jobId, { timeBudgetMs: options.timeBudgetMs });
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Étapes
// ────────────────────────────────────────────────────────────────────────────

/** PLAN : construit le plan de rendu + génère/envoie le fichier ASS. */
async function stagePlan(job: RenderJob, io: EngineIo): Promise<void> {
  // Timeline matérialisée ICI (Task 1-a FIX 2) : la lazy-init partagée avec
  // la route GET (timeline-bootstrap) construit la timeline depuis le
  // scénario si l'utilisateur n'a jamais ouvert le panneau — idempotent.
  const { project, timeline } = await ensureProjectTimeline(job.userId, job.projectId);
  if (!project.script) throw new Error("Scénario absent au moment du rendu.");

  const images = await listAssets(job.userId, job.projectId, "image");
  const imageByScene = new Map(images.filter((a) => a.role?.startsWith("scene:")).map((a) => [a.sceneId!, a]));
  const narrations = await listAssets(job.userId, job.projectId, "audio_narration");
  const narrationByScene = new Map(narrations.filter((a) => a.sceneId).map((a) => [a.sceneId!, a]));
  const sfxAssets = await listAssets(job.userId, job.projectId, "audio_sfx");
  const sfxByName = new Map(sfxAssets.filter((a) => a.role?.startsWith("sfx:")).map((a) => [a.role!.slice(4) as SfxName, a]));
  const musicAssets = await listAssets(job.userId, job.projectId, "audio_music");

  // Garde-fou : éléments audio manquants synthétisés ici (SFX procéduraux,
  // lit musical) — le rendu n'échoue pas pour un SFX manquant.
  const neededSfx = [...new Set(project.script.scenes.flatMap((s) => s.soundEffects))];
  const missingSfx = neededSfx.filter((name) => !sfxByName.has(name));
  const musicBedExplicit = timeline.musicBed?.assetId ? await getAsset(job.userId, timeline.musicBed.assetId) : null;
  if (missingSfx.length > 0 || (!musicBedExplicit && musicAssets.length === 0)) {
    const ensured = await ensureAudioAssetsForProject({
      userId: job.userId,
      project,
      totalDurationSec: project.script.estimatedDurationSec,
      neededSfx: missingSfx,
    });
    for (const [name, asset] of ensured.sfxByName) sfxByName.set(name, asset);
    if (ensured.musicBed) musicAssets.push(ensured.musicBed);
  }
  const musicBedFinal = musicBedExplicit ?? musicAssets[0];

  const dims = renderDimensions(project);
  let assR2Key: string | undefined;
  if (timeline.captions.enabled) {
    const ass = buildAssForRender(project, timeline, dims.width, dims.height);
    if (ass) {
      const upload = await uploadVideoAsset({
        userId: job.userId,
        projectId: job.projectId,
        domain: "subtitles",
        body: Buffer.from(ass, "utf8"),
        contentType: "text/plain; charset=utf-8",
        fileName: `subtitles_${job.id.slice(0, 8)}.ass`,
      });
      assR2Key = upload.r2Key;
    }
  }

  const plan = buildRenderPlan({
    project,
    timeline,
    jobId: job.id,
    imageByScene,
    narrationByScene,
    sfxAssetByName: sfxByName,
    musicBedAsset: musicBedFinal,
    derivedTargets: job.exports.map((e) => e.target),
    assR2Key,
  });
  if (plan.segments.length === 0) throw new Error("Plan de rendu vide : aucune scène avec image.");
  // Task 95-c — écriture via la couche résiliente (checkpoint).
  await writeCheckpointSet(JOBS_COLLECTION, job.id, { plan, updatedAt: nowIso() }, job.userId);
  job.plan = plan;
  await io.log(`Plan de rendu établi : ${plan.segments.length} segments, ${plan.estimatedSec} s attendues.`);
}

/** DOWNLOAD : préflight — vérifie que TOUTES les entrées sont résolubles. */
async function stageDownload(job: RenderJob, io: EngineIo): Promise<void> {
  const plan = job.plan;
  if (!plan) throw new Error("Plan absent.");
  const ids = new Set<string>();
  for (const item of plan.audioMix.narration) ids.add(item.assetId);
  for (const item of plan.audioMix.sfx) ids.add(item.assetId);
  for (const item of plan.audioMix.music) ids.add(item.assetId);
  for (const id of ids) {
    const asset = await io.getAsset(id);
    if (!asset) throw new Error(`Asset manquant avant rendu : ${id}`);
  }
  // Fichier ASS matérialisé en local pour le brûlage final.
  if (plan.subtitles?.assR2Key) {
    await io.materializeByName(plan.subtitles.assR2Key, "subtitles.ass");
  }
  await io.log(`Préflight OK (${ids.size} entrées audio vérifiées).`);
}

/**
 * SEGMENTS : rend jusqu'à MAX_SEGMENTS_PER_TICK segments (un par un),
 * checkpoint chacun, en respectant le budget temps du tick (Task 1-a
 * FIX 5b : Date.now() vérifié entre chaque segment en mode sondage).
 */
async function stageSegments(job: RenderJob, io: EngineIo, timeBudgetMs?: number): Promise<StageOutcome> {
  const plan = job.plan!;
  const completed = new Set(job.checkpoints.completedSegments);
  const pending = plan.segments.filter((s) => !completed.has(s.index));
  if (pending.length === 0) {
    await moveToNextStage(job.id, job, "segments");
    return { kind: "continue", stage: job.stage, message: "Tous les segments déjà rendus." };
  }
  const batch = pending.slice(0, MAX_SEGMENTS_PER_TICK);
  const deadlineMs = typeof timeBudgetMs === "number" && timeBudgetMs > 0 ? Date.now() + timeBudgetMs : null;
  const completedAtTickStart = completed.size;

  for (const segment of batch) {
    if (deadlineMs !== null && Date.now() >= deadlineMs) break;
    const filteredPlan: RenderPlan = { ...plan, segments: [segment] };
    await renderSegments({
      plan: filteredPlan,
      io,
      userId: job.userId,
      completedSegments: [...completed],
      // Task 106-fix — checkpoint en MÉMOIRE seulement : Firestore limite à
      // ~1 écriture/seconde/DOCUMENT et un tick écrit déjà claim + checkpoints
      // + release sur le même document — un checkpoint PAR SEGMENT dépassait
      // ce plafond (RESOURCE_EXHAUSTED classé quota → neutralisation
      // silencieuse → re-rendu infini des mêmes segments, constaté en prod).
      // Un SEUL checkpoint consolidé est écrit APRÈS la boucle du tick.
      onSegmentDone: async (index) => {
        completed.add(index);
      },
    });
  }

  // Task 106-fix — UN checkpoint par tick (consultation immédiate par le
  // claim suivant ; les segments réellement rendus sont conservés en local
  // tmp, le pire cas est un re-rendu des derniers segments du tick).
  if (completed.size > completedAtTickStart) {
    await writeCheckpointSet(
      JOBS_COLLECTION,
      job.id,
      {
        "checkpoints.completedSegments": [...completed],
        progress: computeJobProgress("segments", completed.size, plan.segments.length),
        updatedAt: nowIso(),
      },
      job.userId,
    );
  }

  const remaining = plan.segments.length - completed.size;
  if (remaining > 0) {
    return { kind: "continue", stage: "segments", message: `${remaining} segment(s) restant(s).` };
  }
  await moveToNextStage(job.id, job, "segments");
  return { kind: "continue", stage: job.stage, message: "Segments terminés." };
}

/** TRANSITIONS : xfade chaîne sur les segments. */
/** Seuil au-delà duquel l'assemblage récursif (Long Video Engine) s'applique. */
const RECURSIVE_ASSEMBLY_THRESHOLD = 12;

async function stageTransitions(job: RenderJob, io: EngineIo): Promise<StageOutcome> {
  if (job.checkpoints.transitionsDone) {
    await moveToNextStage(job.id, job, "transitions");
    return { kind: "continue", stage: job.stage, message: "Transitions déjà assemblées." };
  }
  const plan = job.plan!;
  const segmentFiles = plan.segments.map((s) => `${io.tmpDir}/segment_${String(s.index).padStart(4, "0")}.mp4`);
  // Garde cross-instance : un seul fichier de segment manquant ferait échouer
  // ffmpeg en code 1 — rollback déterministe au lieu de consommer les relances.
  for (const file of segmentFiles) {
    if (!(await pathExists(file))) {
      await resetToSegments(job.id, job, "segments absents sur cette instance (transitions)");
      return { kind: "continue", stage: "segments", message: "Reprise : segments re-rendus sur cette instance." };
    }
  }

  let assembledFile: string;
  let expectedSec: number;
  if (plan.segments.length > RECURSIVE_ASSEMBLY_THRESHOLD) {
    // Long Video Engine : passes récursives bornées, checkpoint par passe.
    const result = await assembleRecursive({
      plan,
      io,
      segmentFiles,
      startPass: job.checkpoints.transitionPass,
      onPassDone: async (pass) => {
        // Task 95-c — checkpoint de passe via la couche résiliente.
        await writeCheckpointSet(
          JOBS_COLLECTION,
          job.id,
          { "checkpoints.transitionPass": pass, updatedAt: nowIso() },
          job.userId,
        );
      },
    });
    assembledFile = result.file;
    expectedSec = result.expectedDurationSec;
    if (assembledFile !== `${io.tmpDir}/video_noaudio.mp4`) {
      // Normalisation du nom attendu par les étapes suivantes.
      const { rename } = await import("node:fs/promises");
      await rename(assembledFile, `${io.tmpDir}/video_noaudio.mp4`);
    }
  } else {
    const assembled = await assembleTransitions({ plan, io, segmentFiles });
    assembledFile = assembled.file;
    expectedSec = assembled.durationSec;
    if (assembledFile !== `${io.tmpDir}/video_noaudio.mp4`) {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(assembledFile, `${io.tmpDir}/video_noaudio.mp4`);
    }
  }
  await writeCheckpointSet(JOBS_COLLECTION, job.id, { "checkpoints.transitionsDone": true, updatedAt: nowIso() }, job.userId);
  await io.log(`Assemblage vidéo terminé (${Math.round(expectedSec)} s attendues).`);
  await moveToNextStage(job.id, job, "transitions");
  return { kind: "continue", stage: job.stage, message: "Transitions terminées." };
}

/** AUDIO : mixage narration + musique duckée + SFX. */
async function stageAudio(job: RenderJob, io: EngineIo): Promise<void> {
  if (job.checkpoints.audioDone) return;
  const plan = job.plan!;
  const expected = plan.estimatedSec;
  const audioFile = await mixAudio({ plan, io, durationSec: expected });
  if (!audioFile) {
    // Honnêteté d'état : si le plan PRÉVOIT de l'audio (narration/musique/SFX),
    // un mixage null signifie que les assets n'ont pas pu être résolus — on
    // échoue le tick (relance au checkpoint) au lieu de poser un checkpoint
    // « audio fait » qui produirait un master muet et une boucle QC inutile.
    const audioExpected =
      plan.audioMix.narration.length > 0 ||
      plan.audioMix.music.length > 0 ||
      plan.audioMix.sfx.length > 0;
    if (audioExpected) {
      throw new Error(
        "Mixage audio attendu par le plan mais aucun fichier produit (assets musique/SFX indisponibles).",
      );
    }
    await io.log("Aucune entrée audio prévue — vidéo muette assumée (narration/musique absentes).");
  }
  await writeCheckpointSet(JOBS_COLLECTION, job.id, { "checkpoints.audioDone": true, updatedAt: nowIso() }, job.userId);
}

/** SUBTITLES : le fichier ASS est prêt (brûlé au finalize) — checkpoint. */
async function stageSubtitles(job: RenderJob): Promise<void> {
  await writeCheckpointSet(JOBS_COLLECTION, job.id, { "checkpoints.subtitlesDone": true, updatedAt: nowIso() }, job.userId);
}

/** QC : analyse réelle du master intermédiaire, boucle de correction. */
async function stageQc(job: RenderJob, io: EngineIo): Promise<StageOutcome> {
  const plan = job.plan!;
  // Le master préliminaire : vidéo (transitions) + audio muxés sans ASS.
  const masterTmp = join2(io.tmpDir, "master.mp4");
  const videoFile = join2(io.tmpDir, "video_noaudio.mp4");
  // Garde cross-instance : chaque tick peut atterrir sur une instance lambda
  // différente — les fichiers intermédiaires ne survivent pas. Le montage
  // vidéo absent ici ne peut PAS être re-matérialisé (il n'est pas dans R2) :
  // rollback déterministe plutôt qu'un ffmpeg code 1.
  if (!(await pathExists(videoFile))) {
    await resetToSegments(job.id, job, "montage vidéo (video_noaudio) absent sur cette instance (QC)");
    return { kind: "continue", stage: "segments", message: "Reprise : montage vidéo absent, rendu relancé." };
  }
  const audioPath = join2(io.tmpDir, "audio_final.m4a");
  let audioFile: string | null = (await pathExists(audioPath)) ? audioPath : null;
  if (!audioFile && job.checkpoints.audioDone) {
    // L'audio a été mixé sur une autre instance : re-mixage DÉTERMINISTE ici
    // (assets musique/SFX re-téléchargés depuis R2) au lieu d'un mux muet
    // qui relancerait la boucle auto-fix sans jamais aboutir.
    await io.log("QC : fichier audio absent sur cette instance — re-mixage déterministe depuis les assets.");
    audioFile = await mixAudio({ plan, io, durationSec: plan.estimatedSec });
  }
  if (plan.subtitles?.assR2Key) {
    const assPath = join2(io.tmpDir, "subtitles.ass");
    if (!(await pathExists(assPath))) {
      await io.materializeByName(plan.subtitles.assR2Key, "subtitles.ass");
    }
  }
  await finalizeMaster({
    plan,
    io,
    videoNoAudioFile: videoFile,
    audioFile,
    durationSec: plan.estimatedSec,
    burnAssFileName: plan.subtitles?.assR2Key ? "subtitles.ass" : undefined,
  });
  const report = await analyzeRenderedMaster({
    masterFile: masterTmp,
    tmpDir: io.tmpDir,
    plan,
    expectedDurationSec: plan.estimatedSec,
    subtitlesEnabled: Boolean(plan.subtitles?.assR2Key),
  });
  // Task 95-c — rapport QC via la couche résiliente.
  await writeCheckpointSet(
    JOBS_COLLECTION,
    job.id,
    { qcReport: report, "checkpoints.qcDone": true, updatedAt: nowIso() },
    job.userId,
  );
  await io.log(`QC : ${report.passed ? "OK" : `${report.issues.length} problème(s)`}.`);

  const decision = decideAutoFix(report, plan);
  if (decision.action === "fix" && job.autoFixRounds < MAX_AUTO_FIX_ROUNDS) {
    const completed = new Set(job.checkpoints.completedSegments);
    for (const index of decision.reRenderSegments) completed.delete(index);
    // Task 95-c — patch d'autofix via la couche résiliente (la sentinelle
    // FieldValue.increment part telle quelle à Firestore (sentinelle native).
    // une copie assainie — Task 95-b).
    await writeCheckpointSet(
      JOBS_COLLECTION,
      job.id,
      {
        autoFixRounds: FieldValue.increment(1),
        "checkpoints.completedSegments": [...completed],
        "checkpoints.audioDone": job.checkpoints.audioDone && !decision.rebuildAudio,
        "checkpoints.qcDone": false,
        stage: "segments",
        progress: computeJobProgress("segments", completed.size, plan.segments.length),
        updatedAt: nowIso(),
      },
      job.userId,
    );
    await io.log(`QC : correction automatique ronde ${job.autoFixRounds + 1}/${MAX_AUTO_FIX_ROUNDS} (${decision.reRenderSegments.length} segment(s), audio ${decision.rebuildAudio ? "oui" : "non"}).`);
    return { kind: "continue", stage: "segments", message: "Boucle de correction relancée." };
  }
  await moveToNextStage(job.id, job, "qc");
  return { kind: "continue", stage: job.stage, message: "QC validé." };
}

/** EXPORTS : formats dérivés (9:16 avec sous-titres Shorts, 1:1…). */
async function stageExports(job: RenderJob, io: EngineIo): Promise<StageOutcome> {
  const plan = job.plan!;
  // Master présent dans le tmp ? Sinon (job d'export seul), matérialisation depuis R2.
  const { access } = await import("node:fs/promises");
  try {
    await access(`${io.tmpDir}/master.mp4`);
  } catch {
    if (!plan.masterR2Key) throw new Error("Master absent du tmp et aucune clé R2 de référence.");
    await io.materializeByName(plan.masterR2Key, "master.mp4");
    await io.log("Master téléchargé depuis le stockage pour les exports.");
  }
  const pending = job.exports.filter((e) => e.status === "pending");
  for (const target of pending) {
    const isVertical = target.target.endsWith("9_16");
    let assFileName: string | undefined;
    if (plan.subtitles?.assR2Key) {
      assFileName = "subtitles.ass";
      if (isVertical) {
        const project = await getOwnedProjectOrThrow(job.userId, job.projectId);
        const shortsAss = buildShortsAss(project, 1080, 1920);
        if (shortsAss) await io.writeTmp("subtitles_shorts.ass", shortsAss);
        assFileName = shortsAss ? "subtitles_shorts.ass" : "subtitles.ass";
      }
    }
    const outFile = await renderExportFormat({
      io,
      masterFile: join2(io.tmpDir, "master.mp4"),
      target: target.target,
      assFileName,
    });
    const { readFile, stat } = await import("node:fs/promises");
    const body = await readFile(outFile);
    const sizeBytes = (await stat(outFile)).size;
    const r2Key = await io.uploadRender(`renders/${job.id}/export_${target.target}.mp4`, body, "renders");
    const index = job.exports.findIndex((e) => e.target === target.target);
    job.exports[index] = { ...target, r2Key, sizeBytes, status: "done" };
    const doneCount = job.exports.filter((e) => e.status === "done").length;
    // Task 95-c — état des exports via la couche résiliente.
    await writeCheckpointSet(
      JOBS_COLLECTION,
      job.id,
      {
        exports: job.exports,
        progress: computeJobProgress("exports", doneCount, job.exports.length),
        updatedAt: nowIso(),
      },
      job.userId,
    );
    await io.log(`Export ${target.target} livré (${Math.round(sizeBytes / 1024 / 1024)} Mo).`);
  }
  const remaining = job.exports.filter((e) => e.status === "pending").length;
  if (remaining > 0) {
    return { kind: "continue", stage: "exports", message: `${remaining} export(s) restant(s).` };
  }
  await moveToNextStage(job.id, job, "exports");
  return { kind: "continue", stage: job.stage, message: "Exports terminés." };
}

/** FINALIZE : upload master, règlement wallet, projet terminé, purge, notification. */
async function stageFinalize(job: RenderJob, io: EngineIo): Promise<StageOutcome> {
  const plan = job.plan!;
  // Job d'export seul : pas de re-upload ni de re-facturation du master.
  if (job.mode === "exports_only") {
    const doneCount = job.exports.filter((e) => e.status === "done").length;
    if (job.billedMinor > 0) {
      await settleExportsBudget({ userId: job.userId, jobId: job.id, reservedMinor: job.billedMinor, targets: doneCount });
    }
    await writeCheckpointSet(
      JOBS_COLLECTION,
      job.id,
      { status: "completed", stage: "finalize", progress: 1, leaseOwner: FieldValue.delete(), leaseExpiresAt: 0, updatedAt: nowIso() },
      job.userId,
    );
    await cleanupJobTmp(job.id);
    await logSystem(job.projectId, `Exports additionnels livrés (${doneCount}).`).catch(() => undefined);
    await createNotification({
      userId: job.userId,
      type: "info",
      title: "Formats de diffusion prêts",
      body: `${doneCount} format(s) dérivé(s) (Shorts/TikTok/Reels/carré) disponibles dans le studio vidéo.`,
    }).catch(() => undefined);
    return { kind: "terminal", result: { jobId: job.id, status: "completed", stage: "finalize", done: true, continued: false, message: "Exports livrés." } };
  }
  // Task 95-c — IDEMPOTENCE FINALIZE (risque de double exécution après une
  // reprise quota) : si le master a déjà été téléversé (output/plan présents
  // dans le document fraîchement lu), on ne re-téléverse PAS et on ne
  // re-facture PAS (settle + stats) — seule l'écriture de l'état final
  // complété est (re)faite. Le premier passage garde le chemin nominal.
  const alreadyDelivered = Boolean(job.plan?.masterR2Key) || Boolean(job.output?.r2Key);
  if (alreadyDelivered) {
    await writeCheckpointSet(
      JOBS_COLLECTION,
      job.id,
      { status: "completed", stage: "finalize", progress: 1, leaseOwner: FieldValue.delete(), leaseExpiresAt: 0, updatedAt: nowIso() },
      job.userId,
    );
    await setProjectStatus(job.userId, job.projectId, "completed");
    await cleanupJobTmp(job.id);
    await logSystem(job.projectId, `Rendu ${job.id.slice(0, 8)} déjà livré — état final reconfirmé sans re-facturation (reprise après incident).`).catch(() => undefined);
    return { kind: "terminal", result: { jobId: job.id, status: "completed", stage: "finalize", done: true, continued: false, message: "Rendu déjà livré — état final confirmé." } };
  }
  if (!(await pathExists(join2(io.tmpDir, "master.mp4")))) {
    // Le master n'existe que sur l'instance qui a produit la QC — s'il manque
    // ici, impossible à re-matérialiser (pas encore dans R2) : re-rendu.
    await resetToSegments(job.id, job, "master absent sur cette instance avant livraison");
    return { kind: "continue", stage: "segments", message: "Reprise : master absent, rendu relancé." };
  }
  const uploaded = await uploadMaster({
    io,
    masterFile: join2(io.tmpDir, "master.mp4"),
    projectId: job.projectId,
    jobId: job.id,
  });
  const actualMinor = await settleRenderBudget({
    userId: job.userId,
    jobId: job.id,
    estimate: estimateRenderCost({ durationSec: plan.estimatedSec, resolution: plan.resolution }),
    actualDurationSec: uploaded.durationSec,
  });
  await writeCheckpointSet(
    JOBS_COLLECTION,
    job.id,
    {
      status: "completed",
      stage: "finalize",
      progress: 1,
      leaseOwner: FieldValue.delete(),
      leaseExpiresAt: 0,
      "plan.masterR2Key": uploaded.r2Key,
      output: { r2Key: uploaded.r2Key, sizeBytes: uploaded.sizeBytes, durationSec: uploaded.durationSec, width: uploaded.width, height: uploaded.height },
      billedMinor: actualMinor,
      updatedAt: nowIso(),
    },
    job.userId,
  );
  await setProjectStatus(job.userId, job.projectId, "completed");
  await adminDb.collection("videoProjects").doc(job.projectId).set(
    { stats: { renderedSeconds: uploaded.durationSec, billedMinor: FieldValue.increment(actualMinor) }, updatedAt: nowIso() },
    { merge: true },
  );
  await cleanupJobTmp(job.id);
  await logSystem(job.projectId, `Rendu ${job.id.slice(0, 8)} TERMINÉ : ${uploaded.durationSec.toFixed(1)} s, ${Math.round(uploaded.sizeBytes / 1024 / 1024)} Mo, ${job.exports.filter((e) => e.status === "done").length} export(s). Facturé ${actualMinor} minor.`).catch(() => undefined);
  await createNotification({
    userId: job.userId,
    type: "info",
    title: "Vidéo prête",
    body: `Votre rendu (${uploaded.durationSec.toFixed(0)} s, ${plan.resolution}) est disponible dans le studio vidéo, avec ses exports de diffusion.`,
  }).catch(() => undefined);
  return { kind: "terminal", result: { jobId: job.id, status: "completed", stage: "finalize", done: true, continued: false, message: "Rendu livré." } };
}

function join2(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

// ────────────────────────────────────────────────────────────────────────────
// Engine IO — implémentation concrète (R2 réel, cloisonnement propriétaire)
// ────────────────────────────────────────────────────────────────────────────

function buildEngineIo(job: RenderJob, tmpDir: string): EngineIo {
  return {
    tmpDir,
    getAsset: (assetId) => getAsset(job.userId, assetId),
    materialize: async (asset: VideoAsset, fileName) =>
      materializeForRender({ userId: job.userId, r2Key: asset.r2Key, tmpDir, fileName, maxBytes: 512 * 1024 * 1024 }),
    materializeByName: (r2Key, fileName) =>
      materializeForRender({ userId: job.userId, r2Key, tmpDir, fileName, maxBytes: 512 * 1024 * 1024 }),
    writeTmp: async (fileName, content) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const target = join(tmpDir, fileName);
      await writeFile(target, content, "utf8");
      return target;
    },
    uploadRender: async (fileName, body) => {
      const upload = await uploadVideoAsset({
        userId: job.userId,
        projectId: job.projectId,
        domain: "renders",
        body,
        contentType: "video/mp4",
        fileName: fileName.split("/").pop(),
      });
      return upload.r2Key;
    },
    log: async (message) => {
      await logSystem(job.projectId, message);
      // Fil conducteur : le dernier journal est posé SUR le job (diagnostic
      // production immédiat — quelles étapes ont réellement tourné).
      await adminDb
        .collection(JOBS_COLLECTION)
        .doc(job.id)
        .set({ lastLog: message.slice(0, 280) }, { merge: true })
        .catch(() => undefined);
    },
  };
}

/** Existence d'un chemin sur le disque LOCAL de cette instance (jamais jeté). */
async function pathExists(path: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remise déterministe au stage « segments » : les fichiers intermédiaires ne
 * survivent pas d'une instance lambda à l'autre (/tmp local). Les images se
 * re-téléchargent depuis R2 et le rendu repart du début des segments —
 * correct à toute étape car TOUTE la production est déterministe.
 */
async function resetToSegments(jobId: string, job: RenderJob, reason: string): Promise<void> {
  const totalSegments = job.plan?.segments?.length ?? 0;
  await writeCheckpointSet(
    JOBS_COLLECTION,
    jobId,
    {
      stage: "segments",
      progress: computeJobProgress("segments", 0, totalSegments),
      "checkpoints.completedSegments": [],
      "checkpoints.transitionsDone": false,
      "checkpoints.audioDone": false,
      "checkpoints.subtitlesDone": false,
      "checkpoints.qcDone": false,
      updatedAt: nowIso(),
    },
    job.userId,
  );
  job.stage = "segments";
  job.checkpoints = {
    ...job.checkpoints,
    completedSegments: [],
    transitionsDone: false,
    audioDone: false,
    subtitlesDone: false,
    qcDone: false,
  };
  await logSystem(
    job.projectId,
    `Rendu ${jobId.slice(0, 8)} : ${reason} — reprise déterministe depuis les segments.`,
  ).catch(() => undefined);
}

/** Récupère un job pour lecture (worker sans user : vérification interne). */
export async function getJob(jobId: string): Promise<RenderJob | null> {
  const snap = await adminDb.collection(JOBS_COLLECTION).doc(jobId).get();
  if (!snap.exists) return null;
  const job = snap.data() as RenderJob;
  job.progress = normalizeStoredProgress(job.progress);
  return job;
}

/**
 * Tick autonome : prend le prochain job en file et le fait avancer
 * (utilisé par le worker standalone scripts/video-worker.mts).
 * Le claim est le MÊME que celui des ticks QStash (transaction + bail) :
 * worker local et continuation serveur ne se doublent jamais.
 */
export async function claimNextQueuedJob(): Promise<RenderJob | null> {
  // Task 95-c — lecture via la couche résiliente (Firestore unique moteur) ;
  // tri mémoire par création identique à l'ancienne requête Firestore.
  const jobs = await queryJobDocs<RenderJob>(JOBS_COLLECTION, "status", "queued", { orderField: "createdAt" });
  for (const candidate of jobs) {
    const outcome = await claimJobForTick(candidate.id).catch(() => null);
    if (outcome?.kind === "claimed") return outcome.job;
  }
  return null;
}

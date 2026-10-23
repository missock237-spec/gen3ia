import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 19 : Render Queue + orchestrateur de
 * production (spec §19).
 *
 * File de rendu avec états QUEUED/PROCESSING/PAUSED/FAILED/CANCELLED/
 * COMPLETED, étapes idempotentes, CHECKPOINTS (reprise au segment N après
 * un échec à 73 % — jamais de re-rendu complet), continuation arrière-plan
 * via la FILE DE TICKS R2 (le rendu survit aux fermetures d'onglets et aux
 * échéances serverless — aucun plafond journalier, l'ancienne file externe
 * QStash est retirée du projet), annulation, pause/reprise, nettoyage du tmp, facturation
 * reserve→settle/release et notification de livraison.
 *
 * Task 1-a (rendu réellement fonctionnel) :
 * - publication via la file de ticks R2 (ticket durable + délivrance
 *   immédiate du worker) avec résultat discriminé — plus aucun échec
 *   silencieux de continuation ;
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
 *   même sans file tant que le studio est ouvert).
 *
 * DÉCOUPAGE (réfactor socle commun) : ce fichier est l'ORCHESTRATEUR de
 * ticks (démarrage, contrôles utilisateur, claim/bail, dispatch d'étape,
 * échec, sweep, sondage). Les pièces factorisées vivent dans :
 *   - lib/video/queue-core.ts    : socle commun des deux files ;
 *   - lib/video/render-job.ts    : collection, progression, étape suivante, tmp ;
 *   - lib/video/render-stages.ts : les 9 étapes de rendu + EngineIo.
 * La surface publique de ce module est inchangée (réexports ci-dessous) :
 * aucun appelant ni test n'est modifié.
 */

import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "@/lib/r2fs";
import type {
  RenderJob,
  RenderJobStatus,
  RenderStage,
  RenderUserContract,
  VideoExportTarget,
} from "@/lib/video/types";
import { getOwnedProjectOrThrow, logSystem, setProjectStatus } from "@/lib/video/project-service";
import { listAssets } from "@/lib/video/asset-service";
import { createJobTmpDir } from "@/lib/video/render/engine";
import { estimateRenderCost, reserveRenderBudget, releaseRenderBudget } from "@/lib/video/credits";
import { VIDEO_LIMITS, VideoQuotaError } from "@/lib/video/security";
import { enqueueVideoRenderTick, type TickPublishResult } from "@/lib/queue/tick-queue";
import { logger } from "@/lib/observability/logger";
import {
  classifyTickError,
  createJobDoc,
  loadJobDoc,
  resumePolicyFor,
  type RenderJobWithResume,
  type ResumePolicy,
} from "@/lib/video/queue-resume";
import { firestoreUsable, writeCheckpointSet } from "@/lib/db/firestore-resilient";
import { publishTickAndLog, tickUrl, leaseActive, sweepStaleJobs, advancePendingJob, claimNextQueuedJobDoc, nowIso } from "@/lib/video/queue-core";
import { normalizeStoredProgress, mirrorRenderProgress, moveToNextStage, cleanupJobTmp, JOBS_COLLECTION, STAGE_ORDER, RENDER_RETRY_BUDGET } from "@/lib/video/render-job";
import {
  stagePlan,
  stageDownload,
  stageSegments,
  stageTransitions,
  stageAudio,
  stageSubtitles,
  stageQc,
  stageExports,
  stageFinalize,
  buildEngineIo,
  pathExists,
  restoreRenderedArtifactsFromR2,
  allCompletedSegmentsPersisted,
  resetToSegments,
  type StageOutcome,
} from "@/lib/video/render-stages";

// ────────────────────────────────────────────────────────────────────────────
// Surface publique — constantes/helpers déplacés dans render-job.ts
// (réexports à l'identique : aucun importeur ne change).
// ────────────────────────────────────────────────────────────────────────────

export { JOBS_COLLECTION, RENDER_RETRY_BUDGET, computeJobProgress } from "@/lib/video/render-job";

/** Budget de travail par défaut d'une avance « sondage » (route GET responsive). */
export const POLL_ADVANCE_BUDGET_MS = 55_000;
/** Échéance d'un tick au-delà de laquelle on re-file le job (continuation). */
const TICK_DEADLINE_MS = 230_000;

// ────────────────────────────────────────────────────────────────────────────
// Démarrage d'un rendu
// ────────────────────────────────────────────────────────────────────────────

export async function startRenderJob(params: {
  userId: string;
  projectId: string;
  derivedTargets: VideoExportTarget[];
  /**
   * Task 119 — CONTRAT UTILISATEUR porté par le job (durée/voix/sous-titres
   * demandés) : la QC le vérifie sur le master rendu. Absent → rendu lancé
   * hors production autopilote (contrôles plan seuls).
   */
  contract?: RenderUserContract;
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
    ...(params.contract ? { contract: params.contract } : {}),
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
      await logSystem(params.projectId, `Continuation de file indisponible (${published.message.slice(0, 200)}) — le rendu avancera par sondage du studio ou worker local.`);
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
// Publication dans la file de ticks R2 (continuation arrière-plan)
// ────────────────────────────────────────────────────────────────────────────

export function videoTickUrl(origin: string): string {
  return tickUrl(origin, "api/video/worker/tick");
}

/**
 * Publie un tick de rendu dans la FILE DE TICKS R2 (ex-QStash) : ticket
 * durable sous queue/tickets/v1/ + délivrance immédiate du receiver. ORIGINE
 * CANONIQUE (fix CodeQL request-forgery) : résolue en interne depuis
 * GEN3IA_APP_ORIGIN (allowlist serveur) — jamais depuis une origine de
 * requête. Retourne un résultat DISCRIMINÉ : « unconfigured » couvre R2
 * absent ET origine non résolue (la continuation par sondage prend le
 * relais), « error » est à journaliser (jamais de fantôme « queued »).
 */
export async function publishVideoTick(jobId: string, delaySeconds = 1): Promise<TickPublishResult> {
  return enqueueVideoRenderTick(jobId, delaySeconds);
}

/**
 * Publication interne : renvoie true si le tick est enfilé ; journalise
 * les échecs RÉELS (mode error) — le mode unconfigured (R2 absent ou
 * origine canonique non résolue) est le fonctionnement normal en
 * environnement sans file (continuation par sondage).
 */
async function publishTickAndLogRender(job: Pick<RenderJob, "id" | "projectId">, delaySeconds = 0): Promise<boolean> {
  return publishTickAndLog(job, publishVideoTick, "du studio ou worker local", delaySeconds);
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
  await publishTickAndLogRender(job);
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

// ────────────────────────────────────────────────────────────────────────────
// Claim transactionnel + bail (Task 1-a FIX 5d)
// ────────────────────────────────────────────────────────────────────────────

type ClaimOutcome =
  | { kind: "claimed"; job: RenderJob }
  | { kind: "missing" }
  | { kind: "terminal"; job: RenderJob }
  | { kind: "lease-held"; job: RenderJob };

/**
 * Prise de possession ATOMIQUE (transaction Firestore) : lit le statut ET
 * pose le bail dans le même commit — deux ticks / deux polls concurrents
 * ne peuvent pas tous deux « claimed ». Un statut terminal est un no-op
 * (redélivrance de file après complétion), un bail vivant aussi.
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
 * un tick de file (continuation) — le rendu ne dépend d'aucun onglet ouvert.
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
  // disponible.
  // Task 127 — RESTAURATION R2 D'ABORD : les artefacts PERSISTÉS dans R2
  // (segments rendus, montage, master pré-livraison) sont re-téléchargés —
  // le re-rendu complet (resetToSegments) ne reste que pour l'inconnu.
  const io = buildEngineIo(job, tmpDir);
  if (!(await pathExists(tmpDir))) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(tmpDir, { recursive: true });
    if (
      job.mode !== "exports_only" &&
      STAGE_ORDER.indexOf(job.stage) > STAGE_ORDER.indexOf("segments")
    ) {
      if (allCompletedSegmentsPersisted(job)) {
        try {
          const restored = await restoreRenderedArtifactsFromR2(job, io);
          if (restored.segments > 0 || restored.videoNoaudio || restored.master) {
            await logSystem(
              job.projectId,
              `Rendu ${job.id.slice(0, 8)} : ${restored.segments} segment(s) + montage ${restored.videoNoaudio ? "✓" : "—"} + master ${restored.master ? "✓" : "—"} restaurés depuis R2 (instance relais) — poursuite sans re-rendu.`,
            ).catch(() => undefined);
          }
        } catch {
          await resetToSegments(jobId, job, "restauration R2 impossible après incident");
        }
      } else {
        await resetToSegments(jobId, job, "instance relais sans fichiers temporaires persistés");
      }
    }
  }
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
    // (le tick suivant — file ou sondage — doit pouvoir claimr aussitôt).
    await releaseLease(jobId);
    if (outcome.kind === "next") {
      await moveToNextStage(jobId, job, startedStage);
      const deadlineSoon = Date.now() + 30_000 > Date.parse(job.deadlineAt ?? "0");
      const enqueued = await publishTickAndLogRender(job, deadlineSoon ? 1 : 0);
      const refreshed = await refreshJob(jobId);
      return { jobId, status: refreshed.status, stage: refreshed.stage, done: false, continued: enqueued, message: `Étape ${startedStage} terminée.` };
    }
    const enqueued = await publishTickAndLogRender(job, outcome.delaySeconds ?? 0);
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
      const enqueued = await publishTickAndLogRender(job, policy.delaySeconds);
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
      const enqueued = await publishTickAndLogRender(job, 15);
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
  return sweepStaleJobs<RenderJob>({
    collection: JOBS_COLLECTION,
    normalize: (stored) => ({
      ...stored,
      attempts: typeof stored.attempts === "number" ? stored.attempts : 0,
      retryCount: typeof stored.retryCount === "number" ? stored.retryCount : 0,
      progress: normalizeStoredProgress(stored.progress),
      billedMinor: typeof stored.billedMinor === "number" ? stored.billedMinor : 0,
    }),
    isStale: (job, now) => {
      const deadlineAt = job.deadlineAt ? Date.parse(job.deadlineAt) : Number.NaN;
      // Sans marqueur d'échéance (document historique), on ne juge pas.
      return Number.isFinite(deadlineAt) && deadlineAt <= now;
    },
    fail: (job) => failJob(job, new Error("Échéance de traitement dépassée (worker interrompu) — reprise au dernier checkpoint.")),
  });
}

/**
 * Continuation par SONDAGE (Task 1-a FIX 5b) : fait avancer d'UN tick un
 * job en attente DANS la requête de polling (GET render) — le rendu avance
 * même quand la file n'est pas configurée ou qu'un publish échoue, tant que
 * le studio reste ouvert. Le claim transactionnel garantit qu'un sondage
 * concurrent ne peut pas doubler un tick de file (bail). Ne fait rien si le
 * job est terminal, en pause ou détenu par un worker vivant.
 */
export async function maybeAdvancePendingJob(jobId: string, options: { timeBudgetMs?: number } = {}): Promise<TickResult | null> {
  return advancePendingJob(
    async () => {
      const job = await getJob(jobId);
      return job;
    },
    () => advanceJob(jobId, { timeBudgetMs: options.timeBudgetMs }),
  );
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
 * Le claim est le MÊME que celui des ticks de file (transaction + bail) :
 * worker local et continuation serveur ne se doublent jamais.
 */
export async function claimNextQueuedJob(): Promise<RenderJob | null> {
  // Task 95-c — lecture via la couche résiliente (Firestore unique moteur) ;
  // tri mémoire par création identique à l'ancienne requête Firestore.
  return claimNextQueuedJobDoc<RenderJob>({
    collection: JOBS_COLLECTION,
    claim: async (candidateId) => {
      const outcome = await claimJobForTick(candidateId).catch(() => null);
      return outcome?.kind === "claimed" ? outcome.job : null;
    },
  });
}

import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 20 : file de PRODUCTION AUTOPILOTE (Task 1-a FIX 7).
 *
 * Le dos de l'intégration chat/agent : à partir d'UN prompt utilisateur,
 * cette file enchaîne TOUTE la chaîne de production réelle — création du
 * projet, plan du Directeur, scénario, visuels (Consistency Engine), voix,
 * rendu (file de rendu module 19) — une ÉTAPE par tick, re-file via QStash
 * (pattern PATH BRUT → repli encodé partagé) ET continuation par sondage
 * (GET production) pour fonctionner SANS QStash.
 *
 * Architecture strictement miroir de render-queue (module 19) :
 * - claim TRANSACTIONNEL Firestore avec bail (leaseOwner + leaseExpiresAt) :
 *   deux ticks/polls concurrents ne peuvent pas travailler le même job ;
 * - budget de relance `retryCount` distinct du compteur informatif
 *   `attempts` (un job de 40 ticks garde ses 3 relances) ;
 * - progression STOCKÉE en 0..1 (contrat UI ×100) pondérée par étapes ;
 * - checkpoints sceneCursor : les visuels/narrations reprennent là où ils
 *   se sont arrêtés, jamais de re-génération complète ;
 * - facturation EXISTANTE honorée : billImageGeneration (visuels générés),
 *   billTts (caractères ElevenLabs réels) — le rendu réserve/règle/libère
 *   son propre budget via startRenderJob.
 * - reprise QUOTA-AWARE (Task 95-d, miroir du rendu Task 95-c) : les
 *   documents job passent par la couche résiliente Firestore-only, et un
 *   incident QUOTA ne consomme PAS le budget de relance (backoff
 *   automatique, checkpoints conservés, aucune fausse notification
 *   d'échec). Task 108 : le second backend est supprimé — sous quota, les
 *   ticks sont neutralisés puis republiés (routes + sweep + cron).
 *
 * DÉCOUPAGE (réfactor socle commun) : ce fichier est l'ORCHESTRATEUR de
 * ticks (création, claim/bail, dispatch d'étape, échec, sweep, sondage,
 * lectures, événement SSE). Les pièces factorisées vivent dans :
 *   - lib/video/queue-core.ts        : socle commun des deux files ;
 *   - lib/video/production-job.ts    : contrat du job + helpers purs ;
 *   - lib/video/production-stages.ts : les 7 étapes du pipeline ;
 *   - lib/video/production-delivery.ts : livraison chat (Task 107-a).
 * La surface publique de ce module est inchangée (réexports ci-dessous) :
 * aucun appelant ni test n'est modifié.
 */

import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/observability/logger";
import { enqueueVideoProductionTick, type TickPublishResult } from "@/lib/queue/tick-queue";
import { createProject, logSystem } from "@/lib/video/project-service";
import { VideoProjectCreateSchema, DirectorBriefSchema, RenderRequestSchema, VIDEO_LIMITS } from "@/lib/video/security";
import { parseEffectPreset } from "@/lib/video/effect-presets";
import { publishTickAndLog, tickUrl, leaseActive, sweepStaleJobs, advancePendingJob, claimNextQueuedJobDoc, nowIso } from "@/lib/video/queue-core";
import {
  classifyTickError,
  createJobDoc,
  loadJobDoc,
  queryJobDocs,
  resumePolicyFor,
  type ResumePolicy,
} from "@/lib/video/queue-resume";
import { firestoreUsable, writeCheckpointSet } from "@/lib/db/firestore-resilient";
import {
  PRODUCTION_JOBS_COLLECTION,
  PRODUCTION_LEASE_MS,
  PRODUCTION_RETRY_BUDGET,
  evaluateNextAttemptAtGuard,
  normalizeJobDoc,
  type ProductionJobOptions,
  type ProductionJobStatus,
  type ProductionJobWithResume,
  type ProductionStage,
  type ProductionStageTimelineEntry,
  type VideoProductionJob,
} from "@/lib/video/production-job";
import {
  ensureStageEntry,
  moveToNextProductionStage,
  stageDone,
  stageAssets,
  stagePlan,
  stageProject,
  stageRender,
  stageScript,
  stageVoice,
  type ProductionStageResult,
} from "@/lib/video/production-stages";
import { deliverJobToConversation } from "@/lib/video/production-delivery";

// ────────────────────────────────────────────────────────────────────────────
// Surface publique — contrat du job déplacé dans production-job.ts
// (réexports à l'identique : aucun importeur ne change).
// ────────────────────────────────────────────────────────────────────────────

export {
  PRODUCTION_JOBS_COLLECTION,
  PRODUCTION_STAGES,
  PRODUCTION_JOB_STATUSES,
  PRODUCTION_STAGE_WEIGHTS,
  PRODUCTION_RETRY_BUDGET,
  ASSET_BATCH_SIZE,
  SCENE_VIDEO_MIN_START_BUDGET_MS,
  MAX_SCENE_FAILURES,
  MAX_JOB_WARNINGS,
  PRODUCTION_LEASE_MS,
  PRODUCTION_POLL_ADVANCE_BUDGET_MS,
  computeProductionProgress,
  nextAssetWindow,
  sceneFailureKey,
  shouldSkipScene,
  recordSceneFailure,
  scenePendingRetry,
  appendJobWarning,
  sceneWarningMessage,
  firstSceneNeedingRetry,
  countPermanentlyIgnoredScenes,
  evaluateNextAttemptAtGuard,
} from "@/lib/video/production-job";
export type {
  ProductionStage,
  ProductionJobStatus,
  ProductionStageTimelineEntry,
  ProductionJobOptions,
  VideoProductionJob,
  AssetWindow,
  NextAttemptGuardResult,
} from "@/lib/video/production-job";
export { buildVideoDeliveryMessage, deliverJobToConversation } from "@/lib/video/production-delivery";
export type { VideoDeliveryMessageParams } from "@/lib/video/production-delivery";

// ────────────────────────────────────────────────────────────────────────────
// Création d'un job (entrée chat/agent — outil video.create)
// ────────────────────────────────────────────────────────────────────────────

export interface CreateVideoProductionJobParams {
  userId: string;
  /** Brief créatif complet (même validation que POST .../plan). */
  prompt: string;
  title?: string;
  options?: ProductionJobOptions;
  /**
   * Task 107-a — conversation d'origine (chat IA). Portée PAR L'APPELANT
   * (intercept du chat, tour vidéo, contexte d'exécution de l'outil) —
   * JAMAIS exposée comme entrée LLM (l'IA ne doit pas pouvoir l'inventer).
   * Validation : trim, borné à 128 caractères ; invalide/vide → ignoré
   * (le job se comporte exactement comme un job hors chat).
   */
  conversationId?: string;
}

export interface CreateVideoProductionJobResult {
  jobId: string;
  projectId: string;
  status: "queued";
  stage: ProductionStage;
  /** Mode de continuation effectif : file de ticks R2 si configurée, sinon sondage. */
  queueMode: "queue" | "poll";
}

/**
 * Task 107-a — normalise la conversation d'origine : trim, bornée à 128
 * caractères ; vide ou surdimensionnée → undefined (jamais de champ sale).
 */
function normalizeConversationId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  return trimmed;
}

function deriveTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const cleaned = firstLine.replace(/^[#>*\-\s]+/, "").replace(/["'`]/g, "").trim();
  const base = cleaned.length >= 3 ? cleaned.slice(0, 60) : "Vidéo Gen3ia";
  return base.length < 3 ? "Vidéo Gen3ia" : base;
}

/**
 * Crée le projet vidéo (MÊME chemin que POST /api/video/projects :
 * VideoProjectCreateSchema + createProject), puis le job de production,
 * puis publie le premier tick via le publisher corrigé (path brut → repli
 * encodé). QStash absent n'est PAS une erreur : le résultat porte le mode
 * de continuation effectif (sondage) et l'appelant peut en informer l'IA.
 */
export async function createVideoProductionJob(params: CreateVideoProductionJobParams): Promise<CreateVideoProductionJobResult> {
  // ROBUSTESSE (fix capture 13:02) — bornes pipeline appliquées À L'ENTRÉE,
  // DÉFENSE EN PROFONDEUR pour TOUS les appelants (chat, mission, outil,
  // atelier) : une demande « 5 secondes » est servie à la durée minimale du
  // pipeline (10 s) au lieu d'échouer en validation ; un brief trop court
  // est enrichi du titre ; un titre trop court est déduit du brief. La
  // plateforme AJUSTE ce qu'elle peut ajuster — elle ne refuse JAMAIS une
  // demande réalisable pour un paramètre hors bornes.
  const options = { ...(params.options ?? {}) };
  const durationRaw = Number(options.targetDurationSec);
  if (Number.isFinite(durationRaw) && durationRaw > 0) {
    options.targetDurationSec = Math.min(VIDEO_LIMITS.maxDurationSec, Math.max(VIDEO_LIMITS.minDurationSec, Math.round(durationRaw)));
  } else {
    delete options.targetDurationSec;
  }
  // Task 134 — DÉFENSE EN PROFONDEUR sur les nouvelles options de création :
  // style/position de sous-titres et preset d'effets sont validés (catalogues
  // fermés) — une valeur invalide d'un LLM est écartée silencieusement plutôt
  // que de faire échouer la production (l'utilisateur garde le défaut).
  const styleRaw = options.subtitleStyle;
  if (styleRaw !== undefined) {
    const known = ["documentary", "minimal", "shorts_bold", "cinematic_yellow", "karaoke_pop"] as const;
    if (typeof styleRaw === "string" && (known as readonly string[]).includes(styleRaw)) {
      options.subtitleStyle = styleRaw as (typeof known)[number];
    } else {
      delete options.subtitleStyle;
    }
  }
  const positionRaw = options.subtitlePosition;
  if (positionRaw !== undefined) {
    if (positionRaw === "bottom" || positionRaw === "center" || positionRaw === "top") {
      options.subtitlePosition = positionRaw;
    } else {
      delete options.subtitlePosition;
    }
  }
  const presetParsed = parseEffectPreset(options.effectPreset);
  if (presetParsed) {
    options.effectPreset = presetParsed;
  } else if (options.effectPreset !== undefined) {
    delete options.effectPreset;
  }
  // Task 154 — levier clips vidéo IA : booléen strict (toute autre valeur
  // est écartée silencieusement — le défaut reste « activé si configuré »).
  if (options.videoClips !== undefined) {
    if (typeof options.videoClips === "boolean") {
      options.videoClips = options.videoClips as boolean;
    } else {
      delete options.videoClips;
    }
  }
  const promptRaw = (params.prompt ?? "").trim();
  const briefSource =
    promptRaw.length >= 10
      ? promptRaw
      : [promptRaw, (params.title ?? "").trim()].filter((part) => part.length > 0).join(" — ");
  const brief = DirectorBriefSchema.parse({
    brief: (briefSource.length >= 10 ? briefSource : `Production vidéo : ${briefSource || "demande utilisateur"}`).slice(0, 4000),
  }).brief;
  const title = (params.title?.trim().length ?? 0) >= 3 ? params.title!.trim().slice(0, 200) : deriveTitle(brief);

  // Même validation que POST /api/video/projects (les clés inconnues comme
  // voiceEnabled/subtitlesEnabled sont retirées par le schéma — elles
  // restent portées par job.options pour les étapes voix/rendu).
  const projectInput = VideoProjectCreateSchema.parse({
    ...(options ?? {}),
    title,
    description: params.options?.audience ? `Brief : ${brief.slice(0, 1500)}` : brief.slice(0, 2000),
  });
  const project = await createProject(params.userId, projectInput);

  const derivedTargets = params.options?.derivedTargets
    ? RenderRequestSchema.parse({ derivedTargets: params.options.derivedTargets }).derivedTargets
    : [];

  const jobId = randomUUID();
  const now = nowIso();
  // Task 107-a — conversation d'origine persistée SEULEMENT si valide
  // (pas de champ undefined sale : Firestore les rejette).
  const conversationId = normalizeConversationId(params.conversationId);
  const job: VideoProductionJob = {
    id: jobId,
    userId: params.userId,
    projectId: project.id,
    prompt: brief,
    title,
    // Options BORNÉES (fix captures 13:02) : le job porte la même durée
    // clampée que la validation — jamais la valeur hors bornes d'origine.
    options: { ...options, derivedTargets },
    ...(conversationId ? { conversationId } : {}),
    status: "queued",
    stage: "project",
    stageIndex: 0,
    progress: 0,
    sceneCursor: 0,
    attempts: 0,
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
    timeline: [],
  };
  // Task 95-d — création via la couche résiliente (Task 108 : Firestore
  // unique moteur — un incident quota est propagé à l'appelant). PAS de
  // compensation : AUCUNE réservation wallet ne précède cette création — les
  // visuels/TTS sont facturés au réel au fil de l'eau pendant les ticks et
  // le rendu réserve/libère SON propre budget dans startRenderJob ; une
  // erreur ici ne bloque donc jamais de fonds (rien à rembourser).
  await createJobDoc(PRODUCTION_JOBS_COLLECTION, jobId, { ...job }, params.userId);
  await logSystem(project.id, `Production autopilote ${jobId.slice(0, 8)} enfile (prompt : ${brief.slice(0, 120)}).`).catch(() => undefined);

  // ORIGINE CANONIQUE (fix CodeQL request-forgery) : publishProductionTick
  // résout GEN3IA_APP_ORIGIN en interne (allowlist serveur) — l'origine
  // n'est plus un paramètre d'appelant (falsifiable).
  const published = await publishProductionTick(jobId);
  if (!published.ok && published.mode === "error") {
    // PAS d'échec bloquant : continuation par sondage (GET production) —
    // mais l'incident est journalisé (jamais de fantôme silencieux).
    await logSystem(project.id, `Continuation de file indisponible (${published.message.slice(0, 200)}) — avancement par sondage du studio.`).catch(() => undefined);
  }

  return { jobId, projectId: project.id, status: "queued", stage: "project", queueMode: published.ok ? "queue" : "poll" };
}

// ────────────────────────────────────────────────────────────────────────────
// Publication dans la file de ticks R2 (même pattern que le rendu)
// ────────────────────────────────────────────────────────────────────────────

export function productionTickUrl(origin: string): string {
  return tickUrl(origin, "api/video/worker/production-tick");
}

/**
 * Publie un tick de production dans la FILE DE TICKS R2 (ex-QStash).
 * ORIGINE CANONIQUE (fix CodeQL request-forgery) : résolue en interne depuis
 * GEN3IA_APP_ORIGIN (allowlist serveur) — jamais depuis une origine de
 * requête. « unconfigured » couvre R2 absent ET origine non résolue
 * (la continuation par sondage prend le relais).
 */
export async function publishProductionTick(jobId: string, delaySeconds = 1): Promise<TickPublishResult> {
  return enqueueVideoProductionTick(jobId, delaySeconds);
}

async function publishTickAndLogProduction(job: Pick<VideoProductionJob, "id" | "projectId">, delaySeconds = 0): Promise<boolean> {
  return publishTickAndLog(job, publishProductionTick, "du studio", delaySeconds);
}

// ────────────────────────────────────────────────────────────────────────────
// Claim transactionnel + bail (structure exactement miroir du rendu)
// ────────────────────────────────────────────────────────────────────────────

type ProductionClaimOutcome =
  | { kind: "claimed"; job: VideoProductionJob; previousStatus: ProductionJobStatus }
  | { kind: "missing" }
  | { kind: "terminal"; job: VideoProductionJob }
  | { kind: "lease-held"; job: VideoProductionJob };

/**
 * Prise de possession ATOMIQUE (transaction Firestore) : lit le statut ET
 * pose le bail dans le même commit — deux ticks / deux polls concurrents
 * ne peuvent pas tous deux « claimed ». Un statut terminal est un no-op
 * (redélivrance de file après complétion), un bail vivant aussi.
 */
async function claimProductionJob(jobId: string): Promise<ProductionClaimOutcome> {
  // Task 106-fix / Task 108 — COHÉRENCE DE RÉGIME : si le disjoncteur quota
  // Firestore est OUVERT, les checkpoints de scène (saveJobDoc) échouent en
  // erreur quota-classifiée — un claim transactionnel qui réussirait encore
  // relirait l'ancien document (checkpoints absents) et re-trerait les mêmes
  // scènes. Le claim renonce DONC aussi (erreur quota-classifiée propagée :
  // le tick est republié avec délai, la reprise se fait après cooldown).
  if (!firestoreUsable()) {
    throw new Error(`Claim impossible : quota Firestore (disjoncteur ouvert) pour ${jobId} — tick reporté.`);
  }
  // Task 95-d — le claim reste TRANSACTIONNEL sur Firestore. Une erreur de
  // QUOTA est propagée telle quelle (Task 108 : plus de failover miroir) —
  // transitoire/fatal : propagation inchangée.
  return adminDb.runTransaction(async (tx) => {
    const ref = adminDb.collection(PRODUCTION_JOBS_COLLECTION).doc(jobId);
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return { kind: "missing" } as const;
    const job = normalizeJobDoc((snapshot.data() ?? {}) as Partial<ProductionJobWithResume>, jobId);
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return { kind: "terminal", job } as const;
    }
    const now = Date.now();
    if (job.status === "processing" && leaseActive(job, now)) {
      return { kind: "lease-held", job } as const;
    }
    const previousStatus = job.status;
    const leaseOwner = `${jobId}:${randomUUID()}`;
    const leaseExpiresAt = now + PRODUCTION_LEASE_MS;
    tx.update(ref, {
      status: "processing",
      leaseOwner,
      leaseExpiresAt,
      attempts: job.attempts + 1,
      updatedAt: nowIso(),
    });
    return {
      kind: "claimed",
      job: { ...job, status: "processing", leaseOwner, leaseExpiresAt, attempts: job.attempts + 1 },
      previousStatus,
    } as const;
  });
}

async function releaseLease(jobId: string): Promise<void> {
  // Task 95-d — écriture via la couche résiliente (best-effort : un échec
  // ici n'annule pas la re-file ; le bail expire de lui-même au pire).
  await writeCheckpointSet(
    PRODUCTION_JOBS_COLLECTION,
    jobId,
    { leaseOwner: null, leaseExpiresAt: 0, updatedAt: nowIso() },
  ).catch(() => undefined);
}

// ────────────────────────────────────────────────────────────────────────────
// Machine d'étapes — UNE étape par tick, re-file jusqu'à complétion
// ────────────────────────────────────────────────────────────────────────────

export interface ProductionTickResult {
  jobId: string;
  projectId: string;
  status: ProductionJobStatus;
  stage: ProductionStage | null;
  progress: number;
  done: boolean;
  continued: boolean;
  renderJobId?: string;
  message: string;
  /**
   * Task 106-c — true quand le tick a été rendu NEUTRE par le garde
   * nextAttemptAt (job en attente de reprise) : aucun travail, aucune
   * consommation de budget, état du job restauré.
   */
  skipped?: boolean;
}

/**
 * Fait avancer un job de production d'UNE étape. Claim transactionnel avec
 * bail + backoff quota-aware (Task 95-d/108) ; en fin de tick
 * réussi, le bail est libéré AVANT la re-file (le tick suivant — QStash ou
 * sondage — claimr aussitôt). Un incident QUOTA/transitoire ne consomme PAS
 * le budget de relance : re-file automatique avec backoff, checkpoints
 * conservés. Les échecs fatals passent par le budget retryCount (3) puis
 * échec définitif notifié.
 */
export async function advanceProductionJob(jobId: string, options: { timeBudgetMs?: number } = {}): Promise<ProductionTickResult> {
  const outcome = await claimProductionJob(jobId);
  if (outcome.kind === "missing") {
    return { jobId, projectId: "", status: "failed", stage: null, progress: 0, done: true, continued: false, message: "Job de production introuvable." };
  }
  if (outcome.kind === "lease-held") {
    return { jobId, projectId: outcome.job.projectId, status: outcome.job.status, stage: outcome.job.stage, progress: outcome.job.progress, done: false, continued: false, message: "Tick déjà pris en charge par un autre worker (bail actif)." };
  }
  if (outcome.kind === "terminal") {
    const job = outcome.job;
    // Task 107-a — filet de livraison : un job DÉJÀ terminal dont la
    // livraison chat a échoué (marqueur absent) est relu à CHAQUE tick
    // tardif (QStash planifié, sondage, GET) — la reprise ne dépend plus
    // d'un worker vivant. deliverJobToConversation ne lève jamais.
    await deliverJobToConversation(job);
    return {
      jobId,
      projectId: job.projectId,
      status: job.status,
      stage: job.stage,
      progress: job.status === "completed" ? 1 : job.progress,
      done: true,
      continued: false,
      ...(job.renderJobId ? { renderJobId: job.renderJobId } : {}),
      message: job.status === "completed" ? "Production déjà terminée." : job.error ?? (job.status === "cancelled" ? "Production annulée." : "Production terminée."),
    };
  }

  const job = outcome.job;

  // Task 106-c — GARDE nextAttemptAt : un job en attente de reprise (backoff
  // quota/transitoire écrit par failProductionJob) ne doit PAS avancer avant
  // son échéance. Le tick est rendu NEUTRE : le claim vient de poser un bail
  // et de muter le statut → on restaure l'état d'attente EXACT (statut
  // « queued », bail libéré, compteur informatif d'attente), sans consommer
  // retryCount ni marquer d'erreur. Aucune re-publication : le tick en retard
  // (QStash planifié) ou le sondage suivant prendra le relais après l'échéance.
  if (outcome.previousStatus === "queued") {
    const guard = evaluateNextAttemptAtGuard(job, Date.now());
    if (guard.skip) {
      await writeCheckpointSet(
        PRODUCTION_JOBS_COLLECTION,
        job.id,
        {
          status: "queued",
          leaseOwner: null,
          leaseExpiresAt: 0,
          attempts: Math.max(0, job.attempts - 1),
          updatedAt: nowIso(),
        },
        job.userId,
      ).catch((restoreError: unknown) => {
        // Restauration impossible (quota aussi sur la ré-écriture) : le job reste
        // « processing » au bail court — le sweep le remettra en file à
        // l'expiration (230 s). Incident journalisé, jamais de faux échec.
        logger.warn(
          { jobId: job.id, error: restoreError instanceof Error ? restoreError.message : String(restoreError) },
          "production_next_attempt_restore_failed",
        );
      });
      return {
        jobId: job.id,
        projectId: job.projectId,
        status: "queued",
        stage: job.stage,
        progress: job.progress,
        done: false,
        continued: false,
        skipped: true,
        message: guard.message,
      };
    }
  }

  try {
    await ensureStageEntry(job);
    let stageResult: ProductionStageResult;
    switch (job.stage) {
      case "project":
        stageResult = await stageProject(job);
        break;
      case "plan":
        stageResult = await stagePlan(job);
        break;
      case "script":
        stageResult = await stageScript(job);
        break;
      case "assets":
        stageResult = await stageAssets(job, options.timeBudgetMs);
        break;
      case "voice":
        stageResult = await stageVoice(job, options.timeBudgetMs);
        break;
      case "render":
        stageResult = await stageRender(job);
        break;
      case "done":
        stageResult = await stageDone(job);
        break;
      default: {
        const exhaustive: never = job.stage;
        throw new Error(`Étape de production inconnue : ${String(exhaustive)}`);
      }
    }
    return await concludeProductionTick(job, stageResult);
  } catch (error) {
    // Task 95-d — une erreur de QUOTA n'est pas un échec de production : elle
    // ne consomme PAS le budget de relance, ne marque JAMAIS failed et ne
    // notifie pas l'utilisateur. `quotaFailures` alimente le backoff.
    const klass = classifyTickError(error);
    const jobWithResume = job as ProductionJobWithResume;
    const quotaFailures =
      klass === "quota"
        ? (typeof jobWithResume.quotaFailures === "number" ? jobWithResume.quotaFailures : 0) + 1
        : 0;
    const policy = resumePolicyFor(error, quotaFailures);
    // failProductionJob reçoit la politique : quota/transitoire ne
    // consomment PAS le budget, ne marquent JAMAIS failed, ne notifient PAS.
    // (failProductionJob peut propager si la ré-écriture échoue aussi côté
    // couche résiliente — la route tick republiera.)
    return await failProductionJob(job, error instanceof Error ? error : new Error(String(error)), policy, quotaFailures);
  }
}

/** Fin de tick : écrit timeline/progression, libère le bail, re-file. */
async function concludeProductionTick(
  job: VideoProductionJob,
  stageResult: ProductionStageResult,
): Promise<ProductionTickResult> {
  // Terminaisons (production finie ou échec du rendu rattaché).
  if (stageResult.action === "terminal-completed" || stageResult.action === "terminal-failed") {
    const failed = stageResult.action === "terminal-failed";
    const message = failed ? stageResult.message : "Vidéo livrée.";
    const timeline: ProductionStageTimelineEntry[] = job.timeline.map((e) =>
      e.stage === "done" && !e.finishedAt ? { ...e, finishedAt: nowIso(), detail: message } : e,
    );
    // Task 95-d — écriture via la couche résiliente (Firestore unique moteur, Task 108).
    await writeCheckpointSet(
      PRODUCTION_JOBS_COLLECTION,
      job.id,
      {
        status: failed ? "failed" : "completed",
        ...(failed ? { error: message } : {}),
        progress: failed ? job.progress : 1,
        timeline,
        leaseOwner: null,
        leaseExpiresAt: 0,
        updatedAt: nowIso(),
      },
      job.userId,
    );
    if (failed) {
      await logSystem(job.projectId, `Production ${job.id.slice(0, 8)} ÉCHOUÉE : ${message}`).catch(() => undefined);
    } else {
      await logSystem(job.projectId, `Production ${job.id.slice(0, 8)} TERMINÉE — vidéo livrée.`).catch(() => undefined);
    }
    // Task 107-a — LIVRAISON CHAT AUTOMATIQUE à la transition terminale :
    // message + artefact dans la conversation d'origine (idempotence par
    // marqueur). La livraison absorbe ses propres erreurs — le tick
    // terminal reste un succès quoi qu'il arrive.
    await deliverJobToConversation({
      ...job,
      status: failed ? "failed" : "completed",
      ...(failed ? { error: message } : {}),
    });
    return {
      jobId: job.id,
      projectId: job.projectId,
      status: failed ? "failed" : "completed",
      stage: "done",
      progress: failed ? job.progress : 1,
      done: true,
      continued: false,
      ...(job.renderJobId ? { renderJobId: job.renderJobId } : {}),
      message,
    };
  }

  // Bail libéré AVANT toute re-file — le tick suivant doit pouvoir claimr.
  await releaseLease(job.id);

  if (stageResult.action === "advance") {
    const finishedStage = job.stage;
    await moveToNextProductionStage(job, stageResult.detail);
    const enqueued = await publishTickAndLogProduction(job);
    return {
      jobId: job.id,
      projectId: job.projectId,
      status: "processing",
      stage: job.stage,
      progress: job.progress,
      done: false,
      continued: enqueued,
      ...(job.renderJobId ? { renderJobId: job.renderJobId } : {}),
      message: stageResult.detail ?? `Étape ${finishedStage} terminée.`,
    };
  }

  // "stay" : travail partiel (lot de visuels/narrations) ou re-sondage du rendu.
  if (typeof stageResult.mirrorProgress === "number") {
    // Task 95-d — écriture via la couche résiliente (Firestore unique moteur, Task 108).
    await writeCheckpointSet(PRODUCTION_JOBS_COLLECTION, job.id, { progress: stageResult.mirrorProgress, updatedAt: nowIso() }, job.userId);
    job.progress = stageResult.mirrorProgress;
  }
  const enqueued = await publishTickAndLogProduction(job, stageResult.delaySeconds ?? 0);
  return {
    jobId: job.id,
    projectId: job.projectId,
    status: "processing",
    stage: job.stage,
    progress: job.progress,
    done: false,
    continued: enqueued,
    ...(job.renderJobId ? { renderJobId: job.renderJobId } : {}),
    message: stageResult.detail ?? `Étape ${job.stage} en cours.`,
  };
}

/**
 * Échec d'un tick de production — DEUX régimes (Task 95-d, miroir du rendu) :
 *
 * 1. AVEC politique de reprise non consommatrice (`policy.consumeRetry`
 *    false — quota Firestore ou incident transitoire) : le budget
 *    `retryCount` N'EST PAS touché, le job repasse en file avec
 *    `nextAttemptAt` (backoff) et `quotaFailures` (compteur dédié). JAMAIS
 *    d'échec définitif, JAMAIS de notification utilisateur, JAMAIS de
 *    libération de réservation — la reprise se fait au dernier checkpoint
 *    (sceneCursor/stage). Aucune réservation à libérer au niveau production :
 *    les images/TTS sont facturés au réel au fil de l'eau et le job de rendu
 *    (réservé séparément) libère son propre budget sur son propre échec.
 * 2. SANS politique ou politique fatale (legacy) : budget de relance =
 *    `retryCount` (3), puis échec définitif notifié (comportement historique).
 *
 * Toute la fonction est protégée : si la RÉ-ÉCRITURE elle-même échoue
 * (quota aussi sur la ré-écriture), on journalise et on
 * PROPAGE — la route tick ré-enfilera le job.
 */
async function failProductionJob(job: VideoProductionJob, error: Error, policy?: ResumePolicy, quotaFailures?: number): Promise<ProductionTickResult> {
  const message = error.message.slice(0, 800);
  // Régime « reprise » : politique fournie et budget NON consommé (quota /
  // transitoire). Une politique fatale retombe dans le régime legacy.
  const resumeMode = policy ? !policy.consumeRetry : false;
  try {
    if (resumeMode && policy) {
      const isQuota = classifyTickError(error) === "quota";
      // Message stocké actionnable : pour un quota, pas d'alarme utilisateur.
      const storedMessage = isQuota
        ? `Quota Firestore épuisé — reprise automatique programmée (backoff ${policy.delaySeconds} s).`
        : message;
      const patch: Record<string, unknown> = {
        status: "queued",
        error: storedMessage,
        leaseOwner: null,
        leaseExpiresAt: 0,
        nextAttemptAt: new Date(Date.now() + policy.delaySeconds * 1000).toISOString(),
        updatedAt: nowIso(),
      };
      if (isQuota && typeof quotaFailures === "number" && quotaFailures > 0) {
        // Compteur d'incidents quota consécutifs (n'alimente PAS retryCount).
        patch.quotaFailures = quotaFailures;
      }
      await writeCheckpointSet(PRODUCTION_JOBS_COLLECTION, job.id, patch, job.userId);
      // publishTickAndLog retourne la réussite RÉELLE du publish — « continued »
      // reflète l'honnêteté du ré-enfilement (faux = sondage en relais).
      const enqueued = await publishTickAndLogProduction(job, policy.delaySeconds);
      await logSystem(
        job.projectId,
        `Production ${job.id.slice(0, 8)} : incident ${isQuota ? "quota Firestore" : "transitoire"} à l'étape ${job.stage} — reprise automatique dans ${policy.delaySeconds} s (budget de relance intact, checkpoints conservés).`,
      ).catch(() => undefined);
      return {
        jobId: job.id,
        projectId: job.projectId,
        status: "queued",
        stage: job.stage,
        progress: job.progress,
        done: false,
        continued: enqueued,
        ...(job.renderJobId ? { renderJobId: job.renderJobId } : {}),
        message: storedMessage,
      };
    }
    const retryCount = typeof job.retryCount === "number" ? job.retryCount : 0;
    // Régime legacy : jusqu'à PRODUCTION_RETRY_BUDGET relances (comportement
    // historique — budget retryCount consommé, relance à délai fixe).
    if (retryCount < PRODUCTION_RETRY_BUDGET) {
      await writeCheckpointSet(
        PRODUCTION_JOBS_COLLECTION,
        job.id,
        {
          status: "queued",
          error: message,
          retryCount: retryCount + 1,
          leaseOwner: null,
          leaseExpiresAt: 0,
          updatedAt: nowIso(),
        },
        job.userId,
      );
      const enqueued = await publishTickAndLogProduction(job, 20);
      await logSystem(job.projectId, `Production ${job.id.slice(0, 8)} : incident à l'étape ${job.stage} (relance ${retryCount + 1}/${PRODUCTION_RETRY_BUDGET}) — reprise automatique. ${message}`).catch(() => undefined);
      return {
        jobId: job.id,
        projectId: job.projectId,
        status: "queued",
        stage: job.stage,
        progress: job.progress,
        done: false,
        continued: enqueued,
        ...(job.renderJobId ? { renderJobId: job.renderJobId } : {}),
        message,
      };
    }
    await writeCheckpointSet(
      PRODUCTION_JOBS_COLLECTION,
      job.id,
      {
        status: "failed",
        error: message,
        leaseOwner: null,
        leaseExpiresAt: 0,
        updatedAt: nowIso(),
      },
      job.userId,
    );
    await logSystem(job.projectId, `Production ${job.id.slice(0, 8)} ÉCHOUÉE à l'étape ${job.stage} : ${message}`).catch(() => undefined);
    const { createNotification } = await import("@/lib/notifications/repository");
    await createNotification({
      userId: job.userId,
      type: "info",
      title: "Production vidéo échouée",
      body: `La production autopilote a échoué à l'étape « ${job.stage} » : ${message.slice(0, 200)} Les étapes déjà produites restent dans le studio vidéo.`,
    }).catch(() => undefined);
    // Task 107-a — livraison chat de l'échec définitif (même contrat que la
    // complétion : marqueur idempotent, jamais de double message).
    await deliverJobToConversation({ ...job, status: "failed", error: message });
    return {
      jobId: job.id,
      projectId: job.projectId,
      status: "failed",
      stage: job.stage,
      progress: job.progress,
      done: true,
      continued: false,
      ...(job.renderJobId ? { renderJobId: job.renderJobId } : {}),
      message,
    };
  } catch (requeueError) {
    // La ré-écriture elle-même a échoué (quota aussi sur la ré-écriture) :
    // on journalise et on PROPAGE — la route tick ré-enfilera
    // avec délai ; aucun budget consommé côté job.
    logger.warn(
      { jobId: job.id, stage: job.stage, error: requeueError instanceof Error ? requeueError.message : String(requeueError) },
      "fail_production_requeue_failed",
    );
    throw requeueError;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Sweeper + continuation par sondage (miroir du rendu)
// ────────────────────────────────────────────────────────────────────────────

export interface ProductionSweepResult {
  scanned: number;
  requeued: number;
  failed: number;
}

/**
 * Jobs « processing » dont le bail/échéance est dépassé : re-file (ou
 * échec définitif après budget) via failProductionJob — idempotent, ne
 * touche jamais un job vivant.
 */
export async function sweepStaleProductionJobs(): Promise<ProductionSweepResult> {
  // Task 95-d — lecture via la couche résiliente (Firestore unique moteur).
  return sweepStaleJobs<ProductionJobWithResume>({
    collection: PRODUCTION_JOBS_COLLECTION,
    normalize: (stored) => normalizeJobDoc(stored, stored.id),
    isStale: (job, now) => {
      // Sans bail (document historique), l'ancienneté updatedAt tranche (2× bail).
      if (typeof job.leaseExpiresAt !== "number" || job.leaseExpiresAt <= 0) {
        const age = now - Date.parse(job.updatedAt || job.createdAt);
        return Number.isFinite(age) && age > 2 * PRODUCTION_LEASE_MS;
      }
      return true;
    },
    fail: (job) => failProductionJob(job, new Error("Échéance de traitement dépassée (worker interrompu) — reprise à l'étape courante.")),
  });
}

/**
 * Continuation par SONDAGE : fait avancer d'UN tick un job en attente dans
 * la requête de polling (GET production) — la production avance même sans
 * QStash tant que le client garde la page ouverte. Le claim transactionnel
 * empêche les sondages concurrents de doubler un tick QStash.
 */
export async function maybeAdvancePendingProductionJob(jobId: string, options: { timeBudgetMs?: number } = {}): Promise<ProductionTickResult | null> {
  // Task 95-d — lecture via la couche résiliente (miroir chaud sous quota).
  return advancePendingJob(
    async () => {
      const stored = await loadJobDoc<Partial<ProductionJobWithResume>>(PRODUCTION_JOBS_COLLECTION, jobId);
      return stored ? normalizeJobDoc(stored, jobId) : null;
    },
    () => advanceProductionJob(jobId, { timeBudgetMs: options.timeBudgetMs }),
  );
}

/**
 * Task 106-c — Tick autonome PRODUCTION (worker standalone) : prend le
 * prochain job en file et le réclame (MÊME claim transactionnel + bail que
 * les ticks QStash/sondage — worker local et continuations serveur ne se
 * doublent jamais). Les jobs en attente de reprise (nextAttemptAt futur,
 * backoff quota/transitoire) sont sautés SANS claim — le garde
 * evaluateNextAttemptAtGuard évite le cycle claim/restauration inutile.
 * Miroir exact de claimNextQueuedJob (render-queue).
 */
export async function claimNextQueuedProductionJob(): Promise<VideoProductionJob | null> {
  // Lecture via la couche résiliente (miroir chaud sous quota) ; tri mémoire
  // par création identique à la requête du rendu (le plus ancien d'abord).
  const now = Date.now();
  return claimNextQueuedJobDoc<VideoProductionJob>({
    collection: PRODUCTION_JOBS_COLLECTION,
    claim: async (candidateId) => {
      const outcome = await claimProductionJob(candidateId).catch(() => null);
      return outcome?.kind === "claimed" ? outcome.job : null;
    },
    // Job en attente de backoff → pas encore réclamable (avancera à l'échéance).
    skip: (candidate) => evaluateNextAttemptAtGuard(candidate, now).skip,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Lectures (routes propriétaire-scopées)
// ────────────────────────────────────────────────────────────────────────────

export async function getProductionJob(jobId: string): Promise<VideoProductionJob | null> {
  // Task 95-d — lecture via la couche résiliente (miroir chaud sous quota).
  const stored = await loadJobDoc<Partial<ProductionJobWithResume>>(PRODUCTION_JOBS_COLLECTION, jobId);
  if (!stored) return null;
  return normalizeJobDoc(stored, jobId);
}

// ────────────────────────────────────────────────────────────────────────────
// Task 106-c — événement de progression SSE (flux production/stream)
// ────────────────────────────────────────────────────────────────────────────

/** Événement « progress » du flux SSE (contrat du client chat/studio). */
export interface ProductionProgressEvent {
  type: "progress";
  jobId: string;
  projectId: string;
  stage: ProductionStage;
  status: ProductionJobStatus;
  /** 0..1 — progression pondérée (contrat UI ×100). */
  progress: number;
  /** Curseur de lot (scène suivante à traiter — assets/voice). */
  sceneCursor: number;
  /** Journal d'avertissements FR (tolérance par scène) si non vide. */
  warnings?: string[];
  updatedAt: string;
}

/**
 * Construit l'événement « progress » d'un job (PUR, testé) — même contrat
 * que la réponse GET .../production : le flux SSE remplace le polling côté
 * client sans changer la sémantique des champs.
 */
export function buildProductionProgressEvent(job: VideoProductionJob): ProductionProgressEvent {
  return {
    type: "progress",
    jobId: job.id,
    projectId: job.projectId,
    stage: job.stage,
    status: job.status,
    progress: job.progress,
    sceneCursor: job.sceneCursor,
    ...(job.warnings && job.warnings.length > 0 ? { warnings: job.warnings } : {}),
    updatedAt: job.updatedAt,
  };
}

/** Dernier job de production du projet (le plus récent d'abord). */
export async function listProductionJobs(userId: string, projectId?: string): Promise<VideoProductionJob[]> {
  // Task 95-d — lecture via la couche résiliente (miroir chaud sous quota) ;
  // tri en mémoire inchangé (comportement historique).
  const stored = await queryJobDocs<VideoProductionJob>(PRODUCTION_JOBS_COLLECTION, "userId", userId);
  const jobs = stored
    .map((d) => normalizeJobDoc(d as Partial<ProductionJobWithResume>, d.id))
    .filter((j) => !projectId || j.projectId === projectId);
  jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return jobs;
}

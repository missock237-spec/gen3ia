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
 */

import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/observability/logger";
import { enqueueVideoProductionTick, type TickPublishResult } from "@/lib/queue/tick-queue";
import { createProject, getOwnedProjectOrThrow, patchProject, logSystem } from "@/lib/video/project-service";
import { VideoProjectCreateSchema, DirectorBriefSchema, RenderRequestSchema, VIDEO_LIMITS, VideoQuotaError } from "@/lib/video/security";
import { applyProductionPlan } from "@/lib/video/director-service";
import { generateScript } from "@/lib/video/script-service";
import { generateSceneImage, findSceneImage } from "@/lib/video/image-bridge";
import { generateSceneVideo, isSceneVideoServiceEnabled, SceneVideoUnavailableError, startSceneVideoTask, awaitSceneVideoTask, findSceneVideo, type SceneVideoTaskState } from "@/lib/video/scene-video-service";
import { billImageGeneration, billTts } from "@/lib/video/credits";
import { resolvePreferredVoice, withPlatformVoiceFallback, generateSceneNarration, attachRecordingAsNarration } from "@/lib/video/voice-service";
import { listAssets } from "@/lib/video/asset-service";
import { syncVoiceTrack, applyTimelinePatch } from "@/lib/video/timeline-service";
import { ensureMusicBed } from "@/lib/video/audio-engine";
// Task 107-a — createVideoPlaybackUrl : MÊME source que la carte client
// (video-production-card → GET .../render → output.r2Key présigné) pour la
// livraison du master dans le chat à la complétion.
import { createVideoPlaybackUrl, isOwnedVideoKey } from "@/lib/video/storage";
import { startRenderJob, getJob } from "@/lib/video/render-queue";
import type { VideoExportTarget, VideoProject, ScriptScene, VoiceProfile, SubtitleStyleName, VideoEffectPreset, VideoTimeline } from "@/lib/video/types";
import { mergePresetEffects, PRESET_MOTION, parseEffectPreset } from "@/lib/video/effect-presets";
import { buildMotion } from "@/lib/video/motion-service";
import { mapWithConcurrency } from "@/lib/video/concurrency";
import {
  classifyTickError,
  createJobDoc,
  loadJobDoc,
  queryJobDocs,
  resumePolicyFor,
  type ResumePolicy,
} from "@/lib/video/queue-resume";
import { firestoreUsable, writeCheckpointSet } from "@/lib/db/firestore-resilient";

export const PRODUCTION_JOBS_COLLECTION = "videoProductionJobs";

export const PRODUCTION_STAGES = ["project", "plan", "script", "assets", "voice", "render", "done"] as const;
export type ProductionStage = (typeof PRODUCTION_STAGES)[number];

export const PRODUCTION_JOB_STATUSES = ["queued", "processing", "completed", "failed", "cancelled"] as const;
export type ProductionJobStatus = (typeof PRODUCTION_JOB_STATUSES)[number];

/**
 * Progression par étape — CONTRAT STOCKÉ 0..1 (l'UI multiplie par 100) :
 * project 2 %, plan 10 %, script 18 %, assets 18→70 % (par scène),
 * voice 70→80 %, render 80→98 % (miroir du job de rendu), done 100 %.
 */
export const PRODUCTION_STAGE_WEIGHTS: Record<ProductionStage, [number, number]> = {
  project: [0, 0.02],
  plan: [0.02, 0.12],
  script: [0.12, 0.3],
  assets: [0.3, 0.7],
  voice: [0.7, 0.8],
  render: [0.8, 0.98],
  done: [0.98, 1],
};

/** Budget de RELANCE après échec d'étape (distinct du compteur informatif). */
export const PRODUCTION_RETRY_BUDGET = 3;
/** Visuels/narrations traités par tick au maximum (bornage serverless). */
export const ASSET_BATCH_SIZE = 4;
/**
 * Task 154 (reprise inter-ticks) — budget minimal pour DÉMARRER un clip IA
 * (maturation 60–180 s côté Agnes) : les ticks « sondage » courts (20–55 s)
 * ne démarrent rien, le tick worker (bail 230 s) prend le relais.
 */
export const SCENE_VIDEO_MIN_START_BUDGET_MS = 120_000;
/**
 * Task 106-c — TOLÉRANCE PAR SCÈNE : nombre d'échecs d'une même scène
 * (génération d'image / TTS) avant abandon définitif de CETTE scène. Les
 * autres scènes continuent — le rendu ignore déjà les scènes sans visuel.
 */
export const MAX_SCENE_FAILURES = 3;
/** Plafond du journal d'avertissements stocké sur le job (bornage document). */
export const MAX_JOB_WARNINGS = 50;
/** Bail d'un tick de production (mêmes échéances que le rendu). */
export const PRODUCTION_LEASE_MS = 230_000;
/** Budget de travail par défaut d'une avance « sondage » (GET responsive). */
export const PRODUCTION_POLL_ADVANCE_BUDGET_MS = 55_000;

export interface ProductionStageTimelineEntry {
  stage: ProductionStage;
  startedAt?: string;
  finishedAt?: string;
  detail?: string;
}

export interface ProductionJobOptions {
  aspectRatio?: VideoProject["aspectRatio"];
  resolution?: VideoProject["resolution"];
  language?: string;
  targetDurationSec?: number;
  style?: string;
  audience?: string;
  platform?: string;
  /** false → pas de narration (vidéo muette assumée). Défaut : tentative avec voix. */
  voiceEnabled?: boolean;
  /** false → sous-titres désactivés sur la timeline avant rendu. */
  subtitlesEnabled?: boolean;
  /** Task 134 — style de sous-titres demandé à la création (karaoké…). */
  subtitleStyle?: SubtitleStyleName;
  /** Task 134 — position des sous-titres (bottom/center/top). */
  subtitlePosition?: "bottom" | "center" | "top";
  /** Task 134 — ambiance d'effets d'animation appliquée aux clips image. */
  effectPreset?: VideoEffectPreset;
  /** Formats dérivés à produire après le master (validés RenderRequestSchema). */
  derivedTargets?: VideoExportTarget[];
  /**
   * Task 154 — clips vidéo IA par scène (Agnes Video 2.5). Défaut : ACTIVÉ
   * quand le service est configuré (vraie vidéo générée, plus réaliste).
   * false → animation image Ken Burns historique (économie).
   */
  videoClips?: boolean;
}

export interface VideoProductionJob {
  id: string;
  userId: string;
  projectId: string;
  prompt: string;
  title: string;
  options?: ProductionJobOptions;
  status: ProductionJobStatus;
  stage: ProductionStage;
  stageIndex: number;
  /** 0..1 — progression pondérée (contrat UI ×100). */
  progress: number;
  /** Curseur de lot : index de la PROCHAINE scène à traiter (assets/voice). */
  sceneCursor: number;
  /**
   * Task 154 (reprise inter-ticks) — tâches Agnes Video VIVANTES par scène
   * (clé sceneId) : la génération mûrit côté Agnes, le tick suivant re-sonde
   * la MÊME tâche au lieu de re-générer (jamais deux coûts fournisseur pour
   * une même scène). Absent = {} (compatibilité documents historiques).
   */
  sceneVideoTasks?: Record<string, SceneVideoTaskState>;
  error?: string;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  renderJobId?: string;
  /** Compteur informatif de ticks pris en charge. */
  attempts: number;
  /** Budget de relance après échec (sature à PRODUCTION_RETRY_BUDGET). */
  retryCount: number;
  /**
   * Task 106-c — tolérance par scène : compteur d'échecs par scène, clé
   * `« ${stage}:${sceneId} »` (le comptage est PAR ÉTAPE : une scène qui a
   * épuisé ses retentes d'image peut tout à fait réussir son TTS).
   */
  sceneFailures?: Record<string, number>;
  /** Task 106-c — journal d'avertissements FR (scènes en échec, reprises…). */
  warnings?: string[];
  /**
   * Échéance de reprise (backoff quota/transitoire, ISO 8601) — écrite par
   * failProductionJob, HONORÉE par le garde nextAttemptAt (Task 106-c) : un
   * tick arrivant avant l'échéance est un no-op neutre.
   */
  nextAttemptAt?: string;
  /**
   * Task 107-a — conversation d'origine (chat IA) : portée par le job pour
   * que la complétion « monte » le résultat DANS le fil (message + artefact),
   * même si l'utilisateur a fermé la page. Absent = job lancé hors chat
   * (studio, API) → aucune livraison.
   */
  conversationId?: string;
  /**
   * Task 107-a — horodatage ISO de la livraison chat (IDEMPOTENCE) : posé
   * AVANT l'écriture du message, effacé si l'écriture échoue → jamais deux
   * messages pour un même job, jamais de message perdu silencieusement
   * (reprise au tick/sweep suivant).
   */
  chatDeliveredAt?: string;
  createdAt: string;
  updatedAt: string;
  timeline: ProductionStageTimelineEntry[];
}

/**
 * Job enrichi (Task 95-d) — compteur d'incidents quota consécutifs (alimente
 * le backoff). Il vit HORS du type historique : VideoProductionJob et
 * lib/video/types.ts restent inchangés, les documents le portent tel quel.
 */
type ProductionJobWithResume = VideoProductionJob & { quotaFailures?: number };

function nowIso(): string {
  return new Date().toISOString();
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 10_000) / 10_000));
}

/**
 * Progression d'un job de production (contrat 0..1) — interpolée DANS
 * l'étape courante : completed/total (scènes traitées, progression restituée
 * du rendu…) ; total = 0 → début d'étape (1 pour `done`).
 */
export function computeProductionProgress(stage: ProductionStage, completed: number, total: number): number {
  const [start, end] = PRODUCTION_STAGE_WEIGHTS[stage];
  const safeTotal = Math.max(0, total);
  const ratio = safeTotal > 0 ? Math.min(1, Math.max(0, completed / safeTotal)) : stage === "done" ? 1 : 0;
  return clamp01(start + (end - start) * ratio);
}

export interface AssetWindow<T> {
  /** Lot à traiter (≤ batchSize) — reprise où le curseur s'est arrêté. */
  batch: T[];
  /** Curseur APRÈS traitement du lot (checkpoint). */
  nextCursor: number;
  /** true si tout est déjà traité (cursor au bout). */
  done: boolean;
  /** Reste à traiter APRÈS ce lot. */
  remaining: number;
}

/**
 * Math de reprise des lots (sceneCursor) — pure, testée : un curseur
 * tronqué/négatif (document historique corrompu) est borné, jamais OOB.
 */
export function nextAssetWindow<T>(items: readonly T[], cursor: number, batchSize: number): AssetWindow<T> {
  const safeBatch = Math.max(1, Math.floor(batchSize));
  const safeCursor = Math.max(0, Math.min(Math.floor(cursor), items.length));
  const batch = items.slice(safeCursor, safeCursor + safeBatch);
  const nextCursor = safeCursor + batch.length;
  return { batch, nextCursor, done: nextCursor >= items.length, remaining: Math.max(0, items.length - nextCursor) };
}

// ────────────────────────────────────────────────────────────────────────────
// Task 106-c — tolérance par scène : helpers PURES (testés)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Clé de comptage d'échecs d'une scène pour une étape donnée. Le comptage
 * est PAR ÉTAPE (« assets:s3 » ≠ « voice:s3 ») : échouer 3 fois en image ne
 * doit pas pré-condamner la narration de la même scène.
 */
export function sceneFailureKey(stage: ProductionStage, sceneId: string): string {
  return `${stage}:${sceneId}`;
}

/** true si la scène a atteint MAX_SCENE_FAILURES → définitivement ignorée. */
export function shouldSkipScene(failures: Record<string, number> | undefined, sceneKey: string): boolean {
  const count = failures?.[sceneKey];
  return typeof count === "number" && count >= MAX_SCENE_FAILURES;
}

/**
 * Incrémente le compteur d'échecs d'une scène (PUR : retourne un NOUVEAU
 * record, jamais de mutation du document job).
 */
export function recordSceneFailure(failures: Record<string, number> | undefined, sceneKey: string): Record<string, number> {
  return { ...(failures ?? {}), [sceneKey]: (failures?.[sceneKey] ?? 0) + 1 };
}

/** true si la scène a déjà échoué 1..MAX-1 fois → à retenter au prochain tick. */
export function scenePendingRetry(failures: Record<string, number> | undefined, sceneKey: string): boolean {
  const count = failures?.[sceneKey] ?? 0;
  return count > 0 && count < MAX_SCENE_FAILURES;
}

/**
 * Ajoute une warning FR au journal du job (PUR, borné : seules les
 * MAX_JOB_WARNINGS dernières entrées sont conservées — bornage document).
 */
export function appendJobWarning(warnings: string[] | undefined, message: string): string[] {
  const next = [...(warnings ?? []), message];
  return next.length > MAX_JOB_WARNINGS ? next.slice(next.length - MAX_JOB_WARNINGS) : next;
}

/**
 * Message FR de warning par scène (court, actionnable) :
 * « Scène 3 : image non générée (erreur transitoire) — reprise au prochain
tick » ou « … définitivement ignorée après 3 échecs ».
 */
export function sceneWarningMessage(params: {
  /** Étiquette du travail concerné (« image » / « narration »). */
  label: string;
  /** Numéro lisible de la scène (1-based). */
  sceneNumber: number;
  /** Nombre d'échecs enregistrés APRÈS incrément. */
  failures: number;
  /** true → scène abandonnée définitivement. */
  permanentlyIgnored: boolean;
  /** Cause courte (message d'erreur tronqué). */
  cause: string;
}): string {
  const cause = params.cause.trim().slice(0, 120) || "erreur inconnue";
  if (params.permanentlyIgnored) {
    return `Scène ${params.sceneNumber} : ${params.label} définitivement ignorée après ${params.failures} échecs (${cause}).`;
  }
  return `Scène ${params.sceneNumber} : ${params.label} non générée (${cause}) — reprise au prochain tick (échec ${params.failures}/${MAX_SCENE_FAILURES}).`;
}

/**
 * Index (0-based) de la PREMIÈRE scène à retenter (échecs dans [1, MAX-1]),
 * -1 si aucune. Sert à ramener le curseur au prochain tick pour retenter les
 * scènes en échec sans re-générer celles qui ont réussi (idempotence).
 */
export function firstSceneNeedingRetry(
  scenes: ReadonlyArray<{ id: string }>,
  failures: Record<string, number> | undefined,
  stage: ProductionStage,
): number {
  for (let i = 0; i < scenes.length; i += 1) {
    if (scenePendingRetry(failures, sceneFailureKey(stage, scenes[i].id))) return i;
  }
  return -1;
}

/** Nombre de scènes définitivement ignorées (échecs ≥ MAX_SCENE_FAILURES). */
export function countPermanentlyIgnoredScenes(
  scenes: ReadonlyArray<{ id: string }>,
  failures: Record<string, number> | undefined,
  stage: ProductionStage,
): number {
  return scenes.filter((s) => shouldSkipScene(failures, sceneFailureKey(stage, s.id))).length;
}

// ────────────────────────────────────────────────────────────────────────────
// Task 106-c — garde nextAttemptAt (helper PUR, testé)
// ────────────────────────────────────────────────────────────────────────────

export interface NextAttemptGuardResult {
  /** true → le tick doit être un no-op neutre (job en attente de reprise). */
  skip: boolean;
  /** Temps restant avant l'échéance (ms, 0 si pas de garde). */
  waitMs: number;
  /** Détail FR pour le résultat de tick. */
  message: string;
}

/**
 * Décide si un tick doit être RENDU NEUTRE parce que le job attend son
 * `nextAttemptAt` (backoff quota/transitoire écrit par failProductionJob).
 * nextAttemptAt absent, malformé ou déjà passé → tick normal.
 */
export function evaluateNextAttemptAtGuard(
  job: Pick<VideoProductionJob, "nextAttemptAt">,
  now: number,
): NextAttemptGuardResult {
  const raw = job.nextAttemptAt;
  if (!raw) return { skip: false, waitMs: 0, message: "" };
  const due = Date.parse(raw);
  if (!Number.isFinite(due) || due <= now) return { skip: false, waitMs: 0, message: "" };
  const waitMs = due - now;
  return {
    skip: true,
    waitMs,
    message: `Tick ignoré : reprise programmée dans ${Math.ceil(waitMs / 1000)} s (backoff en cours — budget de relance intact, checkpoints conservés).`,
  };
}

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
  return `${origin.replace(/\/$/, "")}/api/video/worker/production-tick`;
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

async function publishTickAndLog(job: Pick<VideoProductionJob, "id" | "projectId">, delaySeconds = 0): Promise<boolean> {
  const published = await publishProductionTick(job.id, delaySeconds);
  if (!published.ok && published.mode === "error") {
    await logSystem(job.projectId, `Continuation de file échouée (${published.message.slice(0, 200)}) — reprise par sondage du studio.`).catch(() => undefined);
  }
  return published.ok;
}

// ────────────────────────────────────────────────────────────────────────────
// Claim transactionnel + bail (structure exactement miroir du rendu)
// ────────────────────────────────────────────────────────────────────────────

type ProductionClaimOutcome =
  | { kind: "claimed"; job: VideoProductionJob; previousStatus: ProductionJobStatus }
  | { kind: "missing" }
  | { kind: "terminal"; job: VideoProductionJob }
  | { kind: "lease-held"; job: VideoProductionJob };

function leaseActive(job: VideoProductionJob, now: number): boolean {
  return typeof job.leaseExpiresAt === "number" && job.leaseExpiresAt > now;
}

/**
 * Normalise un document job (compatibilité champs manquants). Task 95-d :
 * le compteur `quotaFailures` (hors contrat historique) transite tel quel.
 */
function normalizeJobDoc(stored: Partial<ProductionJobWithResume>, id: string): ProductionJobWithResume {
  return {
    id,
    userId: stored.userId ?? "",
    projectId: stored.projectId ?? "",
    prompt: stored.prompt ?? "",
    title: stored.title ?? "",
    ...(stored.options ? { options: stored.options } : {}),
    status: stored.status ?? "queued",
    stage: stored.stage ?? "project",
    stageIndex: typeof stored.stageIndex === "number" ? stored.stageIndex : 0,
    progress: typeof stored.progress === "number" && stored.progress >= 0 && stored.progress <= 1 ? stored.progress : 0,
    sceneCursor: typeof stored.sceneCursor === "number" ? stored.sceneCursor : 0,
    ...(stored.error ? { error: stored.error } : {}),
    ...(stored.leaseOwner ? { leaseOwner: stored.leaseOwner } : {}),
    ...(typeof stored.leaseExpiresAt === "number" ? { leaseExpiresAt: stored.leaseExpiresAt } : {}),
    ...(stored.renderJobId ? { renderJobId: stored.renderJobId } : {}),
    attempts: typeof stored.attempts === "number" ? stored.attempts : 0,
    retryCount: typeof stored.retryCount === "number" ? stored.retryCount : 0,
    // Task 106-c — tolérance par scène + garde nextAttemptAt : champs
    // persistés, transités tels quels (compatibilité documents historiques).
    ...(isSceneFailureRecord(stored.sceneFailures) ? { sceneFailures: stored.sceneFailures } : {}),
    ...(isSceneVideoTaskRecord(stored.sceneVideoTasks) ? { sceneVideoTasks: stored.sceneVideoTasks } : {}),
    ...(Array.isArray(stored.warnings) ? { warnings: stored.warnings.filter((w): w is string => typeof w === "string") } : {}),
    ...(typeof stored.nextAttemptAt === "string" ? { nextAttemptAt: stored.nextAttemptAt } : {}),
    // Task 107-a — livraison chat : champs persistés, transités tels quels
    // (compatibilité documents historiques : absents → non portés).
    ...(typeof stored.conversationId === "string" && stored.conversationId ? { conversationId: stored.conversationId } : {}),
    ...(typeof stored.chatDeliveredAt === "string" && stored.chatDeliveredAt ? { chatDeliveredAt: stored.chatDeliveredAt } : {}),
    createdAt: stored.createdAt ?? nowIso(),
    updatedAt: stored.updatedAt ?? nowIso(),
    timeline: Array.isArray(stored.timeline) ? stored.timeline : [],
    ...(typeof stored.quotaFailures === "number" ? { quotaFailures: stored.quotaFailures } : {}),
  };
}

/** Garde de forme pour sceneFailures (documents corrompus → champ ignoré). */
function isSceneFailureRecord(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "number");
}

/** Garde de forme des tâches vidéo vivantes (documents corrompus → ignorées). */
function isSceneVideoTaskRecord(value: unknown): value is Record<string, SceneVideoTaskState> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (v) =>
      typeof v === "object" && v !== null &&
      typeof (v as SceneVideoTaskState).videoId === "string" && (v as SceneVideoTaskState).videoId.length > 0 &&
      typeof (v as SceneVideoTaskState).billingReference === "string" &&
      typeof (v as SceneVideoTaskState).seconds === "number",
  );
}

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

type ProductionStageResult =
  | { action: "advance"; detail?: string }
  | { action: "stay"; detail?: string; delaySeconds?: number; mirrorProgress?: number }
  | { action: "terminal-completed" }
  | { action: "terminal-failed"; message: string };

/** Marque le début de l'étape courante dans la timeline du job (idempotent). */
async function ensureStageEntry(job: VideoProductionJob): Promise<void> {
  if (job.timeline.some((e) => e.stage === job.stage)) return;
  const timeline: ProductionStageTimelineEntry[] = [...job.timeline, { stage: job.stage, startedAt: nowIso() }];
  job.timeline = timeline;
  // Task 95-d — écriture via la couche résiliente (Firestore unique moteur, Task 108).
  await writeCheckpointSet(PRODUCTION_JOBS_COLLECTION, job.id, { timeline, updatedAt: nowIso() }, job.userId).catch(() => undefined);
}

async function moveToNextProductionStage(job: VideoProductionJob, detail?: string): Promise<void> {
  const index = PRODUCTION_STAGES.indexOf(job.stage);
  const next = PRODUCTION_STAGES[Math.min(index + 1, PRODUCTION_STAGES.length - 1)];
  const timeline: ProductionStageTimelineEntry[] = job.timeline.map((e) =>
    e.stage === job.stage && !e.finishedAt ? { ...e, finishedAt: nowIso(), ...(detail ? { detail } : {}) } : e,
  );
  timeline.push({ stage: next, startedAt: nowIso() });
  const patch = {
    stage: next,
    stageIndex: PRODUCTION_STAGES.indexOf(next),
    progress: computeProductionProgress(next, 0, 0),
    sceneCursor: 0,
    timeline,
    updatedAt: nowIso(),
  };
  // Task 95-d — écriture via la couche résiliente (Firestore unique moteur, Task 108).
  await writeCheckpointSet(PRODUCTION_JOBS_COLLECTION, job.id, patch, job.userId);
  job.stage = next;
  job.stageIndex = patch.stageIndex;
  job.progress = patch.progress;
  job.sceneCursor = 0;
  job.timeline = timeline;
}

/** PROJECT : garde-fou — le projet existe et appartient au propriétaire. */
async function stageProject(job: VideoProductionJob): Promise<ProductionStageResult> {
  const project = await getOwnedProjectOrThrow(job.userId, job.projectId);
  return { action: "advance", detail: `Projet « ${project.title} » prêt.` };
}

/** PLAN : Directeur de production (même appel que POST .../plan). */
async function stagePlan(job: VideoProductionJob): Promise<ProductionStageResult> {
  const { plan } = await applyProductionPlan(job.userId, job.projectId, job.prompt);
  const scenes = plan.structure.reduce((n, c) => n + c.sceneCount, 0);
  return { action: "advance", detail: `Plan appliqué : ${plan.structure.length} chapitre(s), ${scenes} scènes, ${Math.round(plan.targetDurationSec / 60)} min.` };
}

/** SCRIPT : Script Engine (même appel que POST .../script). */
async function stageScript(job: VideoProductionJob): Promise<ProductionStageResult> {
  const result = await generateScript(job.userId, job.projectId);
  const sceneCount = result.script?.scenes.length ?? 0;
  return { action: "advance", detail: `Scénario généré : ${sceneCount} scène(s).` };
}

// ────────────────────────────────────────────────────────────────────────────
// Task 120 — chevauchement assets∥voice : helpers de la vague parallèle
// ────────────────────────────────────────────────────────────────────────────

/** Résultat d'une promesse sans rejet (équivalent mono-promesse d'allSettled). */
type Settled<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };

/** Exécute une tâche sans jamais la laisser rejeter (résultat discriminé). */
async function settle<T>(task: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { status: "fulfilled", value: await task() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

/** Sortie NARRATION d'une scène de la vague (classification locale). */
type SceneNarrationOutcome =
  | { status: "done" }
  | { status: "disabled" }
  | { status: "deferred" }
  | { status: "fatal"; error: unknown };

/**
 * Classe un échec de narration SURVENU PENDANT la vague assets : fatal →
 * tolérance par scène (« voice:… », retentée à l'étape voice) ; quota /
 * transitoire → DIFFÉRÉ à l'étape voice (qui applique le régime adapté du
 * tick) — un incident TTS ne bloque JAMAIS la vague des visuels.
 */
function narrationOutcome(reason: unknown): SceneNarrationOutcome {
  return classifyTickError(reason) === "fatal" ? { status: "fatal", error: reason } : { status: "deferred" };
}

/** Sortie IMAGE + NARRATION + CLIP VIDÉO IA d'une scène de la vague parallèle. */
interface SceneWaveResult {
  image: { status: "ok"; generated: boolean } | { status: "ignored" } | { status: "fatal"; error: unknown };
  narration: SceneNarrationOutcome;
  /**
   * Task 154 — clip vidéo IA (Agnes Video, mode keyframe). JAMAIS bloquant
   * pour la production : un échec (indisponibilité, crédit, quota) dégrade
   * la scène en animation image Ken Burns avec avertissement utilisateur.
   *
   * `pending` = la tâche Agnes vit toujours (échéance du tick atteinte) :
   * le curseur s'ARRÊTE sur cette scène, le tick suivant RE-SONDE la même
   * tâche (reprise inter-ticks — jamais de re-génération). `not_started` =
   * budget trop court pour DÉMARRER (ticks « sondage » 20–55 s) : idem.
   */
  video: { status: "generated" | "reused" | "skipped" | "failed" | "pending" | "not_started"; error?: string };
}

/** Voix résolue + narrations déjà posées (chevauchement assets∥voice). */
interface VoiceOverlapPlan {
  voice: VoiceProfile;
  /** Scènes déjà narrées (idempotence : jamais de double synthèse). */
  narratedSceneIds: Set<string>;
}

/**
 * Prépare le chevauchement : résout la voix (repli plateforme inclus) et les
 * narrations déjà posées. null → PAS de chevauchement (narration désactivée
 * ou résolution impossible) : l'étape voice garde son comportement complet.
 */
async function prepareVoiceOverlap(job: VideoProductionJob, project: VideoProject): Promise<VoiceOverlapPlan | null> {
  if (job.options?.voiceEnabled === false) return null;
  try {
    const voice = withPlatformVoiceFallback(await resolvePreferredVoice(job.userId, project));
    const narrations = await listAssets(job.userId, job.projectId, "audio_narration");
    return { voice, narratedSceneIds: new Set(narrations.filter((a) => a.sceneId).map((a) => a.sceneId!)) };
  } catch {
    return null; // voix/store indisponible : narration laissée à l'étape voice
  }
}

/**
 * Tickets de NOUVELLES images disponibles pour la vague (plafond strict du
 * projet, VIDEO_LIMITS.maxGeneratedImages) : la vérification interne par
 * scène (assertProjectImageBudget) ne voit pas les générations simultanées
 * de la vague — les tickets bornent le départ des générations au RESTE du
 * plafond. Store illisible → Infinity (la garde par scène tranche).
 */
async function remainingImageTickets(job: VideoProductionJob): Promise<number> {
  try {
    const images = await listAssets(job.userId, job.projectId, "image");
    const generatedCount = images.filter((a) => a.origin === "generated").length;
    return Math.max(0, VIDEO_LIMITS.maxGeneratedImages - generatedCount);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Tâche de narration d'UNE scène (voie A enregistrement / voie B TTS
 * facturée au caractère réel) — partagée par l'étape voice et le
 * chevauchement assets∥voice (Task 120). Retourne les caractères facturés.
 */
async function narrationTaskForScene(
  job: VideoProductionJob,
  scene: ScriptScene,
  voice: VoiceProfile,
  alreadyNarrated: boolean,
): Promise<number> {
  if (alreadyNarrated) return 0;
  if (voice.origin === "recording" && voice.sampleR2Key && isOwnedVideoKey(job.userId, voice.sampleR2Key)) {
    // Voie A : enregistrement utilisateur (usage direct de l'échantillon).
    await attachRecordingAsNarration({
      userId: job.userId,
      projectId: job.projectId,
      sceneId: scene.id,
      sampleR2Key: voice.sampleR2Key,
    });
    return 0;
  }
  // Voie B : synthèse ElevenLabs facturée au caractère réel.
  const narration = await generateSceneNarration({
    userId: job.userId,
    projectId: job.projectId,
    sceneId: scene.id,
    narration: scene.narration,
    voice,
  });
  return narration.charactersUsed;
}

/**
 * ASSETS (Task 120 — VAGUE PARALLÈLE + CHEVAUCHEMENT assets∥voice) :
 * visuels de scènes par lots de ≤ ASSET_BATCH_SIZE par tick, chaque scène
 * étant traitée par ≤ VIDEO_LIMITS.maxParallelAssetGenerations workers
 * simultanés (pool maison concurrency.ts — aucune dépendance npm).
 *
 * CHEVAUCHEMENT : la narration d'une scène ne dépend QUE du scénario (pas
 * des images) — elle est générée DANS LA MÊME VAGUE que l'image de sa scène
 * (image et TTS en parallèle par scène). L'étape « voice » suivante devient
 * une finalisation idempotente : les scènes déjà narrées sont traversées
 * sans re-synthèse ni re-facturation (listAssets), la piste voix + le lit
 * musical y sont posés comme avant.
 *
 * CONTRATS PRÉSERVÉS (tests render-queue-resume / production-queue-resume) :
 * - sceneCursor checkpoint UNIQUE consolidé après la vague (limite
 *   Firestore ~1 écriture/s/doc) — la reprise reprend au curseur ;
 * - tolérance PAR SCÈNE (clés « assets:… » / « voice:… » distinctes) : les
 *   échecs FATALS d'image sont isolés par scène (compteur, warning, curseur
 *   avancé, lot continu) ; les échecs QUOTA/TRANSITOIRES d'image
 *   interrompent la vague SANS checkpoint (régime de reprise du tick,
 *   budget intact) — re-traitement idempotent du lot au retour ;
 * - détection SYSTÉMIQUE image : aucune réussite dans le lot + au moins un
 *   échec fatal → la première erreur fatale remonte (panne moteur) ;
 * - échecs de NARRATION : JAMAIS bloquants pour la vague (fatal → compteur
 *   « voice:… » retenté à l'étape voice ; transitoire → différé à l'étape
 *   voice qui le classera correctement) ;
 * - budget images : porte de tickets locale — la vérification par scène
 *   (assertProjectImageBudget) ne voit pas les générations simultanées de
 *   la vague, les tickets bornent les NOUVELLES images au reste du plafond
 *   strict sans jamais le dépasser ;
 * - facturation : images NOUVELLES générées ce tick (billImageGeneration
 *   une fois par vague), TTS au caractère réel PAR narration (billTts).
 *
 * HONNÊTETÉ : la bible visuelle (Consistency Engine) évolue au fil des
 * références établies — en vague, les scènes simultanées partent du même
 * instantané (les scènes démarrées APRÈS une génération bénéficient de la
 * bible rafraîchie, comme le lot client séquentiel).
 */
async function stageAssets(job: VideoProductionJob, timeBudgetMs?: number): Promise<ProductionStageResult> {
  const project = await getOwnedProjectOrThrow(job.userId, job.projectId);
  if (!project.script) throw new Error("Scénario absent à l'étape des visuels.");
  const scenes = project.script.scenes;
  if (scenes.length === 0) throw new Error("Scénario vide : aucune scène à illustrer.");

  const deadlineMs = typeof timeBudgetMs === "number" && timeBudgetMs > 0 ? Date.now() + timeBudgetMs : null;
  const window = nextAssetWindow(scenes, job.sceneCursor, ASSET_BATCH_SIZE);
  let generated = 0;
  let narrated = 0;
  // Task 106-c — état de tolérance (persisté sur le job à chaque checkpoint).
  let sceneFailures = job.sceneFailures ?? {};
  let warnings = job.warnings ?? [];
  // Task 154 (reprise inter-ticks) — tâches Agnes Video vivantes : re-sondées
  // au lieu d'être re-générées (idempotence économique par scène).
  const sceneVideoTasks: Record<string, SceneVideoTaskState> = { ...(job.sceneVideoTasks ?? {}) };
  const sceneVideoTasksAtStart = JSON.stringify(job.sceneVideoTasks ?? {});
  const cursorAtTickStart = job.sceneCursor;
  const failuresAtTickStart = JSON.stringify(sceneFailures);

  // Task 120 — préparation du CHEVAUCHEMENT voice : voix + narrations déjà
  // posées (idempotence). Indisponible (voix irrésolvable, store illisible,
  // narration désactivée) → pas de chevauchement, l'étape voice suivante
  // garde son comportement historique complet.
  const voicePlan = await prepareVoiceOverlap(job, project);

  // Task 120 — porte de budget locale (plafond strict d'images) : tickets de
  // NOUVELLES générations disponibles pour cette vague.
  let newImageTickets = await remainingImageTickets(job);

  // VAGUE PARALLÈLE : chaque worker traite UNE scène — son IMAGE et sa
  // NARRATION démarrent ENSEMBLE (chevauchement assets∥voice) et leurs
  // échecs sont classés séparément : image quota/transitoire → rejet du
  // worker (propagation au régime du tick après la vague) ; image fatale →
  // tolérance par scène ; narration → jamais bloquante pour la vague.
  // NOTE bible visuelle : les scènes de la vague partent du même instantané
  // (≤ maxParallelAssetGenerations ≤ ASSET_BATCH_SIZE démarrent ensemble) ;
  // la bible rafraîchie profite au PROCHAIN lot (relecture à l'entrée du tick
  // suivant — même moteur de cohérence, aucun contournement).
  const outcomes = await mapWithConcurrency(
    window.batch,
    Math.max(1, VIDEO_LIMITS.maxParallelAssetGenerations),
    async (scene): Promise<SceneWaveResult> => {
      const imageTask = settle(async () => {
        if (shouldSkipScene(sceneFailures, sceneFailureKey("assets", scene.id))) {
          return { status: "ignored" as const };
        }
        if (newImageTickets > 0) {
          newImageTickets -= 1; // ticket consommé AVANT la génération (course)
        }
        // Sinon : plus de ticket → assertProjectImageBudget tranche lui-même
        // (VideoQuotaError fatal → tolérance par scène existante).
        const result = await generateSceneImage({ userId: job.userId, project, scene });
        if (result.generated) {
          generated += 1;
        } else {
          newImageTickets += 1; // réutilisation : ticket rendu au reste du plafond
        }
        return { status: "ok" as const, generated: result.generated };
      });
      const narrationTask = voicePlan
        ? settle(async () => {
            const charactersUsed = await narrationTaskForScene(job, scene, voicePlan.voice, voicePlan.narratedSceneIds.has(scene.id));
            if (charactersUsed > 0) {
              // Facturation au caractère réel, PAR narration (comme la boucle
              // historique de l'étape voice — référence unique par appel).
              await billTts(job.userId, job.projectId, charactersUsed);
            }
            return { status: "done" as const };
          })
        : Promise.resolve({ status: "fulfilled" as const, value: { status: "disabled" as const } });
      const imageSettled = await imageTask;
      // Task 154 — CLIP VIDÉO IA : démarre APRÈS l'image (mode keyframe —
      // l'image cohérente devient la first frame du clip) et se poursuit en
      // parallèle de la narration. Échec → dégradation Ken Burns (jamais
      // bloquant) : le rendu n'a simplement pas de videoR2Key pour la scène.
      //
      // REPRISE INTER-TICKS : une tâche Agnes DÉMARRÉE mais non terminée à
      // l'échéance du tick reste dans sceneVideoTasks (persistée sur le job)
      // — le tick suivant RE-SONDE la même tâche au lieu de re-générer
      // (jamais deux coûts fournisseur pour une même scène). Les ticks
      // « sondage » courts (20–55 s) ne DÉMARRENT rien : sans budget minimal
      // ils attendent le tick worker (bail 230 s).
      const videoDeadlineMs = deadlineMs !== null ? deadlineMs - 10_000 : null; // marge avant l'échéance du tick
      const videoTask: Promise<{ status: "fulfilled"; value: { status: "generated" | "reused" | "skipped" | "failed" | "pending" | "not_started"; error?: string } } | { status: "rejected"; reason: unknown }> =
        imageSettled.status === "rejected"
          ? Promise.resolve({ status: "fulfilled" as const, value: { status: "skipped" as const } })
          : settle(async () => {
              if (job.options?.videoClips === false || !isSceneVideoServiceEnabled()) {
                return { status: "skipped" as const };
              }
              try {
                // 1. Tâche vivante → RE-SONDAGE (jamais de re-génération).
                const live = sceneVideoTasks[scene.id];
                if (live) {
                  const outcome = await awaitSceneVideoTask({
                    userId: job.userId,
                    project,
                    scene,
                    task: live,
                    ...(videoDeadlineMs !== null ? { deadlineMs: videoDeadlineMs } : {}),
                  });
                  if (outcome.status === "pending") {
                    return { status: "pending" as const };
                  }
                  delete sceneVideoTasks[scene.id];
                  if (outcome.status === "failed") {
                    return { status: "failed" as const, error: outcome.error };
                  }
                  return { status: "generated" as const };
                }
                // 2. Clip déjà finalisé ? (idempotence — y compris par un tick
                // précédent mort entre register et checkpoint).
                const existing = await findSceneVideo(job.userId, project.id, scene.id);
                if (existing) {
                  return { status: "reused" as const };
                }
                // 3. NOUVELLE tâche : budget minimal requis (maturation 60–180 s
                // côté Agnes) — un tick trop court ne démarre rien.
                if (videoDeadlineMs !== null && Date.now() > videoDeadlineMs - SCENE_VIDEO_MIN_START_BUDGET_MS) {
                  return { status: "not_started" as const };
                }
                const image = imageSettled.status === "fulfilled" && imageSettled.value.status === "ok"
                  ? await findSceneImage(job.userId, project.id, scene.id)
                  : null;
                if (!image) {
                  return { status: "skipped" as const };
                }
                const task = await startSceneVideoTask({ userId: job.userId, project, scene, image });
                sceneVideoTasks[scene.id] = task;
                // Persistance IMMÉDIATE (survie aux crashes) : la tâche
                // démarrée est connue du job AVANT le premier sondage.
                await writeCheckpointSet(
                  PRODUCTION_JOBS_COLLECTION,
                  job.id,
                  { sceneVideoTasks, updatedAt: nowIso() },
                  job.userId,
                ).catch(() => undefined);
                const outcome = await awaitSceneVideoTask({
                  userId: job.userId,
                  project,
                  scene,
                  task,
                  ...(videoDeadlineMs !== null ? { deadlineMs: videoDeadlineMs } : {}),
                });
                if (outcome.status === "pending") {
                  return { status: "pending" as const };
                }
                delete sceneVideoTasks[scene.id];
                if (outcome.status === "failed") {
                  return { status: "failed" as const, error: outcome.error };
                }
                return { status: "generated" as const };
              } catch (error) {
                if (error instanceof SceneVideoUnavailableError || error instanceof VideoQuotaError) {
                  return { status: "failed" as const, error: error.message };
                }
                // Fonds insuffisants (402 wallet) → dégradation contrôlée : la
                // scène garde son animation image, l'utilisateur est averti.
                const message = error instanceof Error ? error.message : String(error);
                if (/insufficient|fonds|solde|wallet/i.test(message)) {
                  return { status: "failed" as const, error: message };
                }
                throw error;
              }
            });
      const narrationSettled = await narrationTask;
      const videoSettled = await videoTask;
      const videoResult = videoSettled.status === "rejected"
        ? { status: "failed" as const, error: videoSettled.reason instanceof Error ? videoSettled.reason.message : String(videoSettled.reason) }
        : videoSettled.value;
      if (imageSettled.status === "rejected") {
        // Image quota/transitoire → PROPAGATION (rejet du worker, isolé par
        // le pool — la première dans l'ORDRE remonte après la vague).
        if (classifyTickError(imageSettled.reason) !== "fatal") throw imageSettled.reason;
        return {
          image: { status: "fatal", error: imageSettled.reason },
          narration: narrationSettled.status === "rejected" ? narrationOutcome(narrationSettled.reason) : narrationSettled.value,
          video: videoResult,
        };
      }
      return {
        image: imageSettled.value,
        narration: narrationSettled.status === "rejected" ? narrationOutcome(narrationSettled.reason) : narrationSettled.value,
        video: videoResult,
      };
    },
    {
      // Budget temps du tick honoré AVANT chaque démarrage de scène (le
      // checkpoint maître reprend les non-démarrées au prochain tick).
      shouldStart: () => deadlineMs === null || Date.now() < deadlineMs,
    },
  );

  // Application DÉTERMINISTE (ordre des scènes) des résultats de la vague.
  let imageFatalInBatch = 0;
  let imageSucceededInBatch = 0;
  let firstImageFatal: unknown = null;
  let firstTickError: unknown;
  let haveTickError = false;
  let pendingSceneVideos = 0;
  let cursor = cursorAtTickStart;
  for (let i = 0; i < window.batch.length; i += 1) {
    const outcome = outcomes[i];
    const scene = window.batch[i];
    const sceneIndex = cursorAtTickStart + i;
    if (outcome.status === "skipped") break; // non démarrée (budget temps)
    if (outcome.status === "rejected") {
      // Erreur transitoire/quota image : le régime de reprise du tick prend
      // le relais (comme l'interruption de la boucle historique) — les
      // scènes suivantes (même réussies) seront re-traitées idempotemment.
      if (!haveTickError) {
        firstTickError = outcome.reason;
        haveTickError = true;
      }
      break;
    }
    const result = outcome.value;
    if (result.image.status === "fatal") {
      sceneFailures = recordSceneFailure(sceneFailures, sceneFailureKey("assets", scene.id));
      const permanentlyIgnored = shouldSkipScene(sceneFailures, sceneFailureKey("assets", scene.id));
      warnings = appendJobWarning(
        warnings,
        sceneWarningMessage({
          label: "image",
          sceneNumber: sceneIndex + 1,
          failures: sceneFailures[sceneFailureKey("assets", scene.id)],
          permanentlyIgnored,
          cause: result.image.error instanceof Error ? result.image.error.message : String(result.image.error),
        }),
      );
      imageFatalInBatch += 1;
      if (firstImageFatal === null) firstImageFatal = result.image.error;
    } else if (result.image.status === "ok") {
      imageSucceededInBatch += 1;
    }
    if (result.narration.status === "fatal") {
      // Tolérance PAR SCÈNE voix (clé « voice:… ») — retentée à l'étape voice.
      sceneFailures = recordSceneFailure(sceneFailures, sceneFailureKey("voice", scene.id));
      const permanentlyIgnored = shouldSkipScene(sceneFailures, sceneFailureKey("voice", scene.id));
      warnings = appendJobWarning(
        warnings,
        sceneWarningMessage({
          label: "narration",
          sceneNumber: sceneIndex + 1,
          failures: sceneFailures[sceneFailureKey("voice", scene.id)],
          permanentlyIgnored,
          cause: result.narration.error instanceof Error ? result.narration.error.message : String(result.narration.error),
        }),
      );
    } else if (result.narration.status === "done") {
      narrated += 1;
    }
    // Task 154 — clip vidéo IA : avertissement HONNÊTE en cas d'échec (la
    // scène est livrée en animation image Ken Burns, jamais bloquée).
    if (result.video.status === "failed") {
      warnings = appendJobWarning(
        warnings,
        `Clip vidéo IA de la scène ${sceneIndex + 1} non généré (${(result.video.error ?? "raison inconnue").slice(0, 160)}) — animation image utilisée.`,
      );
    }
    // Task 154 (reprise inter-ticks) — tâche vivante ou non démarrée : le
    // curseur S'ARRÊTE sur cette scène (sa vidéo mûrit côté Agnes, le tick
    // suivant re-sonde la même tâche — les scènes suivantes, même réussies,
    // seront re-validées idempotemment, sans re-génération).
    if (result.video.status === "pending" || result.video.status === "not_started") {
      pendingSceneVideos += 1;
      break;
    }
    cursor = sceneIndex + 1;
  }
  job.sceneCursor = cursor;

  // Erreur transitoire/quota image → régime de reprise du tick (le
  // checkpoint N'EST PAS écrit : re-traitement idempotent du lot au retour,
  // comportement historique de l'interruption immédiate).
  if (haveTickError) {
    throw firstTickError instanceof Error ? firstTickError : new Error(String(firstTickError));
  }

  // Task 106-c — SYSTÉMIQUE image : aucune réussite dans le lot + au moins un
  // échec fatal → on RENVOIE la première erreur fatale (moteur de visuels
  // indisponible) : le régime de reprise du tick la traite exactement comme
  // avant (re-file 20 s sous budget / échec définitif + notification).
  if (imageFatalInBatch > 0 && imageSucceededInBatch === 0) {
    throw firstImageFatal instanceof Error ? firstImageFatal : new Error(String(firstImageFatal));
  }

  // Task 106-fix — checkpoint CONSOLIDÉ (un par tick) : curseur, progression,
  // tolérance par scène (sceneFailures/warnings) et tâches vidéo vivantes —
  // persistés ensemble.
  if (
    job.sceneCursor !== cursorAtTickStart ||
    JSON.stringify(sceneFailures) !== failuresAtTickStart ||
    JSON.stringify(sceneVideoTasks) !== sceneVideoTasksAtStart
  ) {
    await writeCheckpointSet(
      PRODUCTION_JOBS_COLLECTION,
      job.id,
      {
        sceneCursor: job.sceneCursor,
        progress: computeProductionProgress("assets", job.sceneCursor, scenes.length),
        sceneFailures,
        warnings,
        sceneVideoTasks,
        updatedAt: nowIso(),
      },
      job.userId,
    );
    job.sceneVideoTasks = sceneVideoTasks;
  }

  // Facturation EXISTANTE honorée : uniquement les images NOUVELLEMENT
  // générées CE tick (les réutilisations et les scènes ignorées ne coûtent
  // rien) — AVANT toute sortie de l'étape (retente ou terminaison incluse).
  if (generated > 0) {
    await billImageGeneration(job.userId, job.projectId, generated);
  }

  // Fin de lot : retentes des scènes en échec (curseur ramené à la première
  // scène à retenter — les réussies seront simplement réutilisées).
  const retryIndex = firstSceneNeedingRetry(scenes, sceneFailures, "assets");
  if (retryIndex >= 0 && retryIndex < job.sceneCursor && job.sceneCursor >= scenes.length) {
    job.sceneCursor = retryIndex;
    await writeCheckpointSet(
      PRODUCTION_JOBS_COLLECTION,
      job.id,
      { sceneCursor: retryIndex, sceneFailures, warnings, updatedAt: nowIso() },
      job.userId,
    );
    return {
      action: "stay",
      detail: `${job.sceneCursor}/${scenes.length} visuels — scène(s) en échec à reprendre au prochain tick (tolérance par scène).`,
    };
  }

  if (job.sceneCursor >= scenes.length) {
    const ignored = countPermanentlyIgnoredScenes(scenes, sceneFailures, "assets");
    if (ignored >= scenes.length) {
      // Task 106-c — TOUTES les scènes définitivement ignorées : échec clair,
      // une vidéo sans aucun visuel n'a pas de sens.
      return {
        action: "terminal-failed",
        message: `Production échouée : les ${scenes.length} scène(s) ont été définitivement ignorées après ${MAX_SCENE_FAILURES} échecs de génération d'image. Vérifiez le moteur de visuels ou réessayez plus tard.`,
      };
    }
    // Task 154 (reprise inter-ticks) — des clips mûrissent ENCORE côté Agnes :
    // l'étape reste ouverte, le tick suivant les finalise (re-sondage des
    // MÊMES tâches — jamais de re-génération) avant de passer à la voix.
    const activeVideoTasks = Object.keys(sceneVideoTasks).length;
    if (activeVideoTasks > 0 || pendingSceneVideos > 0) {
      return {
        action: "stay",
        detail: `${scenes.length} visuel(s) prêt(s) — ${activeVideoTasks} clip(s) vidéo IA en cours de génération côté Agnes (reprise au tick suivant).`,
      };
    }
    return {
      action: "advance",
      detail: `${scenes.length} visuel(s) prêt(s) (${generated} généré(s)${ignored > 0 ? `, ${ignored} scène(s) ignorée(s)` : ""})${narrated > 0 ? ` ; ${narrated} narration(s) générée(s) en parallèle (chevauchement voix-visuels)` : ""}.`,
    };
  }
  return {
    action: "stay",
    detail: pendingSceneVideos > 0
      ? `${job.sceneCursor}/${scenes.length} visuels — clip(s) vidéo IA en cours côté Agnes (reprise au tick suivant).`
      : `${job.sceneCursor}/${scenes.length} visuels traités${narrated > 0 ? ` (+${narrated} narration(s) en parallèle)` : ""}.`,
  };
}

/**
 * VOICE : narrations par lots (MÊME chemin que POST .../generate-voice :
 * enregistrement utilisateur ou TTS ElevenLabs facturé au caractère réel),
 * sceneCursor checkpoint par scène. Aucune voix configurée ou narration
 * désactivée → avancement assumé (vidéo muette — le moteur de rendu la
 * gère explicitement) : une production autopilote ne doit pas mourir faute
 * de profil vocal, l'incident est consigné dans la timeline du job.
 *
 * Task 106-c — TOLÉRANCE PAR SCÈNE : même mécanique que l'étape assets.
 * Task 106-c — IDEMPOTENCE : une scène qui possède DÉJÀ une narration n'est
 * JAMAIS re-synthétisée (les retentes/reprises ne re-facturent pas le TTS).
 *
 * Task 120 — FENÊTRE SUR LE TRAVAIL RÉEL : avec le chevauchement
 * assets∥voice, la plupart des scènes arrivent DÉJÀ narrées à cette étape —
 * elles sont TRAVERSÉES sans consommer le lot (aucun tick perdu en no-op),
 * le lot ne compte que les scènes À narrer réellement. La finalisation
 * (piste voix synchronisée + lit musical) reste le passage obligé ici.
 */
async function stageVoice(job: VideoProductionJob, timeBudgetMs?: number): Promise<ProductionStageResult> {
  const project = await getOwnedProjectOrThrow(job.userId, job.projectId);
  if (!project.script) throw new Error("Scénario absent à l'étape de la voix.");
  const scenes = project.script.scenes;

  if (job.options?.voiceEnabled === false) {
    return { action: "advance", detail: "Narration désactivée — vidéo muette assumée." };
  }
  // FIX A3 : la production autopilote ne produit PLUS de vidéo muette faute
  // de profil vocal — elle narrate avec la VOIX PLATEFORME ElevenLabs (repli
  // du pont TTS, même chemin que le chat). Seule l'option explicite
  // voiceEnabled:false garde la vidéo muette assumée.
  const voice = withPlatformVoiceFallback(await resolvePreferredVoice(job.userId, project));

  // Task 106-c — narrations déjà prêtes (idempotence des reprises : jamais
  // de double synthèse / double facturation lors des retentes par scène).
  const existingNarrations = await listAssets(job.userId, job.projectId, "audio_narration");
  const narratedSceneIds = new Set(existingNarrations.filter((a) => a.sceneId).map((a) => a.sceneId!));

  const deadlineMs = typeof timeBudgetMs === "number" && timeBudgetMs > 0 ? Date.now() + timeBudgetMs : null;
  // Task 106-c — état de tolérance (persisté sur le job à chaque checkpoint).
  let sceneFailures = job.sceneFailures ?? {};
  let warnings = job.warnings ?? [];
  // Task 106-c — détection SYSTÉMIQUE (même contrat que stageAssets).
  let succeededInBatch = 0;
  let fatalInBatch = 0;
  let firstFatalError: unknown = null;
  // Task 106-fix — UN SEUL checkpoint par tick (limite Firestore ~1 écriture/s/doc).
  const cursorAtTickStart = job.sceneCursor;
  const failuresAtTickStart = JSON.stringify(sceneFailures);

  // Task 120 — FENÊTRE : traverse les scènes déjà narrées/ignorées SANS les
  // compter dans le lot ; le lot (≤ ASSET_BATCH_SIZE) ne contient que les
  // scènes À NARRER (reprise du chevauchement assets∥voice ou reprise après
  // incident — narratedSceneIds est le point de vérité idempotent).
  const work: Array<{ scene: ScriptScene; sceneIndex: number }> = [];
  let scan = Math.max(0, Math.min(job.sceneCursor, scenes.length));
  while (scan < scenes.length && work.length < ASSET_BATCH_SIZE) {
    const scene = scenes[scan];
    const alreadyDone =
      narratedSceneIds.has(scene.id) || shouldSkipScene(sceneFailures, sceneFailureKey("voice", scene.id));
    if (!alreadyDone) work.push({ scene, sceneIndex: scan });
    scan += 1;
  }
  // Les scènes traversées déjà prêtes comptent comme du PROGRÈS du lot pour
  // la détection systémique (un no-op y comptait comme réussite avant).
  succeededInBatch += Math.max(0, scan - cursorAtTickStart - work.length);

  let processedAllWork = true;
  for (const { scene, sceneIndex } of work) {
    if (deadlineMs !== null && Date.now() >= deadlineMs) {
      processedAllWork = false;
      break;
    }
    const failureKey = sceneFailureKey("voice", scene.id);
    try {
      const charactersUsed = await narrationTaskForScene(job, scene, voice, narratedSceneIds.has(scene.id));
      if (charactersUsed > 0) {
        await billTts(job.userId, job.projectId, charactersUsed);
      }
      succeededInBatch += 1;
    } catch (error) {
      // Task 106-c — quota/transitoire = incident d'infrastructure : PAS une
      // faute de scène, on remonte au régime de reprise du tick.
      if (classifyTickError(error) !== "fatal") throw error;
      sceneFailures = recordSceneFailure(sceneFailures, failureKey);
      const permanentlyIgnored = shouldSkipScene(sceneFailures, failureKey);
      warnings = appendJobWarning(
        warnings,
        sceneWarningMessage({
          label: "narration",
          sceneNumber: sceneIndex + 1,
          failures: sceneFailures[failureKey],
          permanentlyIgnored,
          cause: error instanceof Error ? error.message : String(error),
        }),
      );
      fatalInBatch += 1;
      if (firstFatalError === null) firstFatalError = error;
    }
    job.sceneCursor = sceneIndex + 1;
  }
  // Curseur : tout le travail examiné est franchi (narrées traversées ou
  // scènes traitées) — l'échéance interrompue laisse le curseur à la
  // dernière scène traitée (reprise au prochain tick).
  if (processedAllWork) {
    job.sceneCursor = Math.max(job.sceneCursor, scan);
  }

  // Task 106-c — SYSTÉMIQUE : aucune narration du lot n'aboutit → régime de
  // reprise du tick (identique à l'étape assets).
  if (fatalInBatch > 0 && succeededInBatch === 0) {
    throw firstFatalError instanceof Error ? firstFatalError : new Error(String(firstFatalError));
  }

  // Task 106-fix — checkpoint CONSOLIDÉ (un par tick) : curseur, progression,
  // tolérance par scène — persistés ensemble.
  if (job.sceneCursor !== cursorAtTickStart || JSON.stringify(sceneFailures) !== failuresAtTickStart) {
    await writeCheckpointSet(
      PRODUCTION_JOBS_COLLECTION,
      job.id,
      {
        sceneCursor: job.sceneCursor,
        progress: computeProductionProgress("voice", job.sceneCursor, scenes.length),
        sceneFailures,
        warnings,
        updatedAt: nowIso(),
      },
      job.userId,
    );
  }

  if (job.sceneCursor < scenes.length) {
    return { action: "stay", detail: `${job.sceneCursor}/${scenes.length} narration(s).` };
  }

  // Fin de lot : retentes des narrations en échec (curseur ramené à la
  // première scène à retenter — les prêtes sont sautées par idempotence).
  const retryIndex = firstSceneNeedingRetry(scenes, sceneFailures, "voice");
  if (retryIndex >= 0 && retryIndex < job.sceneCursor) {
    job.sceneCursor = retryIndex;
    await writeCheckpointSet(
      PRODUCTION_JOBS_COLLECTION,
      job.id,
      { sceneCursor: retryIndex, sceneFailures, warnings, updatedAt: nowIso() },
      job.userId,
    );
    return {
      action: "stay",
      detail: `${job.sceneCursor}/${scenes.length} narrations — scène(s) en échec à reprendre au prochain tick (tolérance par scène).`,
    };
  }

  const ignored = countPermanentlyIgnoredScenes(scenes, sceneFailures, "voice");
  if (ignored >= scenes.length) {
    // Task 113 — « résultat plutôt qu'échec » : TOUTES les narrations ont
    // été définitivement abandonnées (ElevenLabs indisponible, clé/quota,
    // panne réseau) → la production est LIVRÉE EN MUET au lieu d'échouer :
    // les visuels déjà générés (facturés) donnent une vidéo complète et le
    // rendu gère explicitement les scènes sans narration. L'incident reste
    // consigné (warnings + détail d'étape) et le studio permet de relancer
    // la narration à tout moment (generate-voice).
    return {
      action: "advance",
      detail: `Narrations indisponibles (${scenes.length} scène(s) ignorée(s) après ${MAX_SCENE_FAILURES} échecs de synthèse) — vidéo muette livrée ; relancez la narration depuis le studio.`,
    };
  }

  // Toutes les narrations prêtes : piste VOIX synchronisée + musique posée
  // (identique à la route generate-voice) si la timeline existe déjà —
  // sinon le stade plan du rendu la construira AVEC les narrations.
  if (project.timeline) {
    const narrations = await listAssets(job.userId, job.projectId, "audio_narration");
    const narrationByScene = new Map(narrations.filter((a) => a.sceneId).map((a) => [a.sceneId!, a]));
    let timeline = syncVoiceTrack(
      project.timeline,
      project.script.scenes
        .filter((s) => narrationByScene.has(s.id))
        .map((s) => ({
          sceneId: s.id,
          assetId: narrationByScene.get(s.id)!.id,
          startSec: s.startSec,
          durationSec: Math.min(s.durationSec, narrationByScene.get(s.id)!.media?.durationSec ?? s.durationSec),
        })),
    );
    if (!timeline.musicBed) {
      const bed = await ensureMusicBed(job.userId, job.projectId, project.musicMood ?? "documentaire", timeline.durationSec);
      timeline = applyTimelinePatch(timeline, "set_music_bed", undefined, { assetId: bed.id, volume: 0.6, duckTo: 0.22 });
    }
    await patchProject(job.userId, job.projectId, { timeline });
  }
  return {
    action: "advance",
    detail: `${scenes.length} narration(s) prête(s) (voix : ${voice.name})${ignored > 0 ? `, ${ignored} ignorée(s)` : ""}.`,
  };
}

/** RENDER : enfile le rendu réel (module 19) — il gère sa propre facturation. */
async function stageRender(job: VideoProductionJob): Promise<ProductionStageResult> {
  // Task 113 — PRÉFLIGHT FFmpeg : résout (et met en cache) les binaires
  // AVANT le startRenderJob — un environnement sans FFmpeg (échec du
  // téléchargement runtime épinglé) est détecté ICI avec un message clair,
  // sans réserver le budget rendu ni consommer les relances sur un échec
  // de spawn cryptique. Le cache d'échec est réinitialisé pour que la
  // relance suivante re-tente vraiment le téléchargement (blip réseau).
  const { resolveFfmpegBinary, resolveFfprobeBinary, resetBinaryResolutionCache } = await import("@/lib/video/security");
  const [ffmpeg, ffprobe] = await Promise.all([resolveFfmpegBinary(), resolveFfprobeBinary()]);
  const diagnostics = [ffmpeg, ffprobe]
    .map((b, i) => (b.diagnostic ? `${i === 0 ? "ffmpeg" : "ffprobe"} : ${b.diagnostic}` : null))
    .filter((d): d is string => typeof d === "string");
  if (diagnostics.length > 0) {
    resetBinaryResolutionCache();
    throw new Error(`Moteur de rendu indisponible sur cette plateforme (${diagnostics.join(" ; ")}) — le rendu sera retenté automatiquement ; aucune facturation tant qu'aucun rendu ne démarre.`);
  }
  const project = await getOwnedProjectOrThrow(job.userId, job.projectId);
  // Task 134 — PRÉPARATION TIMELINE AVANT RENDU : les options de création
  // (sous-titres on/off + style + position, ambiance d'effets) sont
  // appliquées sur la timeline AVANT startRenderJob. La timeline est
  // matérialisée si nécessaire (ensureProjectTimeline, idempotent) — sinon
  // un projet jamais ouvert dans l'atelier ne recevrait jamais les choix
  // exprimés dans la demande (le bootstrap du rendu repart du scénario).
  const wantsSubtitleTuning = Boolean(
    job.options?.subtitleStyle || job.options?.subtitlePosition || job.options?.subtitlesEnabled === false,
  );
  const wantsEffectPreset = Boolean(job.options?.effectPreset && job.options.effectPreset !== "none");
  if (wantsSubtitleTuning || wantsEffectPreset) {
    const { ensureProjectTimeline } = await import("@/lib/video/timeline-bootstrap");
    const ensured = await ensureProjectTimeline(job.userId, job.projectId);
    let timeline = ensured.timeline;
    // 1) Sous-titres : coupure ET style/position demandés à la création.
    const captionsPatch: Partial<VideoTimeline["captions"]> = {};
    if (job.options?.subtitlesEnabled === false) captionsPatch.enabled = false;
    if (job.options?.subtitleStyle) captionsPatch.style = job.options.subtitleStyle;
    if (job.options?.subtitlePosition) captionsPatch.position = job.options.subtitlePosition;
    if (Object.keys(captionsPatch).length > 0) {
      timeline = { ...timeline, captions: { ...timeline.captions, ...captionsPatch } };
    }
    // 2) Effets d'animation : le preset est FUSIONNÉ dans chaque clip image
    // (les effets choisis par le scénario restent maîtres — merge sans
    // doublon) + motion recommandée pour les clips sans mouvement explicite.
    const preset = parseEffectPreset(job.options?.effectPreset);
    if (preset && preset !== "none") {
      const motionPreset = PRESET_MOTION[preset];
      timeline = {
        ...timeline,
        tracks: timeline.tracks.map((track) =>
          track.kind !== "image"
            ? track
            : {
                ...track,
                clips: track.clips.map((clip) => ({
                  ...clip,
                  effects: mergePresetEffects(clip.effects ?? [], preset),
                  ...(!clip.motion && motionPreset ? { motion: buildMotion(motionPreset, clip.durationSec) } : {}),
                })),
              },
        ),
      };
    }
    await patchProject(job.userId, job.projectId, { timeline });
  }
  // Option subtitlesEnabled:false → sous-titres coupés sur la timeline.
  if (job.options?.subtitlesEnabled === false && project.timeline?.captions?.enabled && !wantsSubtitleTuning) {
    await patchProject(job.userId, job.projectId, {
      timeline: { ...project.timeline, captions: { ...project.timeline.captions, enabled: false } },
    });
  }
  const derivedTargets = job.options?.derivedTargets
    ? RenderRequestSchema.parse({ derivedTargets: job.options.derivedTargets }).derivedTargets
    : [];
  // Task 119 — CONTRAT UTILISATEUR porté par le job de rendu : la volonté
  // explicite de l'utilisateur (durée demandée, narration, sous-titres) est
  // vérifiée par la QC sur le master réellement livré (±10 %, flux voix,
  // sous-titres brûlés). Un rendu lancé hors production autopilote ne porte
  // AUCUN contrat (startRenderJob appelé sans ce champ).
  const render = await startRenderJob({
    userId: job.userId,
    projectId: job.projectId,
    derivedTargets,
    contract: {
      targetDurationSec: project.targetDurationSec,
      narrationRequired: job.options?.voiceEnabled !== false,
      captionsRequired: job.options?.subtitlesEnabled !== false && Boolean(project.timeline?.captions?.enabled),
    },
  });
  // Rattaché AVANT le passage à l'étape done (visible même si le tick meurt ici).
  // Task 95-d — écriture via la couche résiliente (Firestore unique moteur, Task 108).
  await writeCheckpointSet(PRODUCTION_JOBS_COLLECTION, job.id, { renderJobId: render.jobId, updatedAt: nowIso() }, job.userId);
  job.renderJobId = render.jobId;
  return { action: "advance", detail: `Rendu ${render.jobId.slice(0, 8)} en file.` };
}

/** DONE : miroir du job de rendu — la production ne termine qu'avec lui. */
async function stageDone(job: VideoProductionJob): Promise<ProductionStageResult> {
  if (!job.renderJobId) throw new Error("Aucun job de rendu rattaché à l'étape finale.");
  const renderJob = await getJob(job.renderJobId);
  if (!renderJob) throw new Error(`Job de rendu ${job.renderJobId.slice(0, 8)} introuvable.`);
  if (renderJob.status === "completed") {
    return { action: "terminal-completed" } as const;
  }
  if (renderJob.status === "failed" || renderJob.status === "cancelled") {
    return { action: "terminal-failed", message: renderJob.errorMessage ?? "Rendu annulé." } as const;
  }
  // Rendu en cours : progression miroir (80→98 %) + re-sondage borné.
  return {
    action: "stay",
    mirrorProgress: computeProductionProgress("render", renderJob.progress, 1),
    delaySeconds: 10,
    detail: `Rendu en cours (${Math.round(renderJob.progress * 100)} %).`,
  } as const;
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
    const enqueued = await publishTickAndLog(job);
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
  const enqueued = await publishTickAndLog(job, stageResult.delaySeconds ?? 0);
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
      const enqueued = await publishTickAndLog(job, policy.delaySeconds);
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
      const enqueued = await publishTickAndLog(job, 20);
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

// ──────────────────────────────────────────────────────────────────────────
// Task 107-a — LIVRAISON CHAT à la complétion : le résultat « monte » dans
// la conversation d'origine (message FR + artefact vidéo) même si la page
// est fermée. Mêmes primitives que le lancement (appendMessage/createArtifact
// via imports DYNAMIQUES — anti-cycle : la couche conversation importe cette
// file, jamais l'inverse). Idempotence par marqueur chatDeliveredAt posé
// AVANT l'écriture : jamais deux messages, jamais de perte silencieuse
// (marqueur effacé en cas d'échec → reprise au tick/sweep suivant).
// ──────────────────────────────────────────────────────────────────────────

/** Étiquettes FR des étapes pour les messages de livraison (ton video-status). */
const DELIVERY_STAGE_LABELS: Record<ProductionStage, string> = {
  project: "création du projet",
  plan: "plan du réalisateur",
  script: "écriture du scénario",
  assets: "génération des visuels",
  voice: "narration vocale",
  render: "montage et rendu",
  done: "finalisation",
};

export interface VideoDeliveryMessageParams {
  /** Statut TERMINAL du job (completed / failed / cancelled). */
  status: ProductionJobStatus;
  title: string;
  projectId: string;
  /** Étape atteinte (précision du message d'échec). */
  stage: ProductionStage;
  /** Message d'erreur stocké (échec définitif) — tronqué à 200 caractères. */
  error?: string;
  /** Journal d'avertissements FR (tolérance par scène) — 3 lignes max. */
  warnings?: string[];
  /** URL de lecture présignée du master (complétion seulement, sinon absent). */
  masterUrl?: string;
}

/**
 * Message FR de livraison (PUR, testé) — même ton que le message de
 * lancement du tour vidéo (runVideoTurn) : titre, avertissements éventuels
 * (3 max), lien de lecture du master, atelier, relance via video.revise.
 */
export function buildVideoDeliveryMessage(params: VideoDeliveryMessageParams): string {
  const lines: string[] = [];
  if (params.status === "completed") {
    lines.push("Votre vidéo est prête 🎬", "");
    lines.push(`Titre : « ${params.title || "Vidéo Gen3ia"} »`);
    const warnings = (params.warnings ?? []).slice(0, 3).map((w) => w.trim().slice(0, 200)).filter(Boolean);
    if (warnings.length > 0) {
      lines.push("Points d'attention pendant la production :");
      for (const warning of warnings) lines.push(`- ${warning}`);
    }
    lines.push(params.masterUrl ? `Regardez votre vidéo ici : ${params.masterUrl}` : "La lecture est disponible dans la carte vidéo ci-dessous.");
    lines.push(`Le projet complet (timeline, versions, exports) est disponible dans l'atelier vidéo : /studio/video/${params.projectId}`);
    lines.push("Demandez-moi des modifications (musique, rythme, visuels…) : je relance une passe de révision (video.revise) sur ce projet.");
    return lines.join("\n");
  }
  if (params.status === "failed") {
    lines.push("Votre production vidéo n'a pas abouti.", "");
    const label = DELIVERY_STAGE_LABELS[params.stage] ?? params.stage;
    const error = params.error?.trim().slice(0, 200);
    lines.push(`Étape : ${label}${error ? ` — ${error}` : "."}`);
    lines.push(`Les étapes déjà produites restent consultables dans l'atelier vidéo : /studio/video/${params.projectId}`);
    lines.push("Demandez-moi une relance ou des ajustements (video.revise) : la production repart du dernier point sauvegardé.");
    return lines.join("\n");
  }
  lines.push("Votre production vidéo a bien été annulée.", "");
  lines.push(`Le projet reste accessible dans l'atelier vidéo : /studio/video/${params.projectId} — vous pouvez relancer la production à tout moment.`);
  return lines.join("\n");
}

/**
 * Livre le résultat d'un job TERMINAL dans sa conversation d'origine :
 * message assistant (contenu FR selon le statut) + artefact vidéo de
 * livraison. NE LÈVE JAMAIS — un incident de livraison est journalisé.
 *
 * Task 113 — ORDRE « LIVRER D'ABORD, MARQUER ENSUITE » : l'ancien ordre
 * (marqueur posé AVANT le message, effacé en cas d'échec) perdait
 * définitivement le message quand l'ÉCRITURE du marqueur AVAIT réussi mais
 * l'effacement échouait (panne du magasin au même instant) — le job restait
 * « livré » sans message et le filet de reprise sortait immédiatement.
 * Désormais :
 *   1. anti-doublon par LECTURE (les derniers messages de la conversation :
 *      un message assistant de livraison pour ce projet prouve la livraison
 *      — le contenu est déterministe sauf l'URL présignée) → re-pose le
 *      marqueur au mieux et sort : jamais de doublon après un incident
 *      « message écrit, marqueur pas écrit » ;
 *   2. appendMessage (LE livrable) — en cas d'échec, AUCUN marqueur posé :
 *     le prochain passage re-livre naturellement ;
 *   3. artefact de livraison (si aucun artefact de lancement/vidéo) ;
 *   4. marqueur chatDeliveredAt (best-effort) — son échec est compensé par
 *      l'anti-doublon 1 (cosmétique : au pire un message en double, JAMAIS
 *      un message perdu).
 */
export async function deliverJobToConversation(job: VideoProductionJob): Promise<void> {
  // Conditions de livraison : conversation connue, pas déjà livré (garde
  // primaire rapide sur le marqueur), statut terminal. Un job hors chat
  // (studio/API) n'a RIEN à livrer.
  if (!job.conversationId || job.chatDeliveredAt) return;
  if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") return;

  try {
    // Imports DYNAMIQUES (anti-cycle) : mêmes primitives que le lancement.
    const { appendMessage, listMessages: listRecent } = await import("@/lib/chat/repository");
    const { createArtifact, listArtifacts } = await import("@/lib/domain/artifacts/repository");

    // 1) ANTI-DOUBLON par lecture du fil : le message de livraison contient
    // toujours le lien studio du projet + une phrase-marker déterministe
    // (l'URL présignée varie, le reste non). Les 40 derniers messages
    // suffisent largement (la livraison suit de près la fin du tour).
    const recent = await listRecent(job.userId, job.conversationId, 40, { order: "recent" }).catch(() => []);
    const studioLink = `studio/video/${job.projectId}`;
    const phrase =
      job.status === "completed"
        ? "Votre vidéo est prête"
        : job.status === "failed"
          ? "Votre production vidéo n'a pas abouti"
          : "a bien été annulée";
    const alreadyDelivered = recent.some(
      (m) => m.role === "assistant" && m.content.includes(phrase) && m.content.includes(studioLink),
    );
    if (alreadyDelivered) {
      // Déjà livré (le marqueur était absent — échec d'écriture antérieur) :
      // re-pose le marqueur au mieux et sort — jamais de doublon.
      await writeCheckpointSet(
        PRODUCTION_JOBS_COLLECTION,
        job.id,
        { chatDeliveredAt: nowIso(), updatedAt: nowIso() },
        job.userId,
      ).catch(() => undefined);
      return;
    }

    // URL de lecture du master : MÊME source que la carte client
    // (video-production-card → GET .../render → output.r2Key présigné) —
    // ici en direct : job de rendu rattaché (job.renderJobId) → clé R2 du
    // master → URL présignée 900 s. L'URL est un PLUS : un incident de
    // signature n'empêche jamais la livraison du message.
    let masterUrl: string | undefined;
    if (job.status === "completed" && job.renderJobId) {
      try {
        const renderJob = await getJob(job.renderJobId);
        const r2Key = renderJob?.output?.r2Key;
        if (r2Key) masterUrl = await createVideoPlaybackUrl(job.userId, r2Key, 900).catch(() => undefined);
      } catch {
        // Rendu introuvable / R2 indisponible : message livré sans URL.
      }
    }

    const content = buildVideoDeliveryMessage({
      status: job.status,
      title: job.title,
      projectId: job.projectId,
      stage: job.stage,
      ...(job.status === "failed" && job.error ? { error: job.error } : {}),
      ...(job.status === "completed" && job.warnings?.length ? { warnings: job.warnings } : {}),
      ...(masterUrl ? { masterUrl } : {}),
    });

    // 2) LE LIVRABLE : le message part AVANT tout marquage. Un échec ici ne
    // laisse AUCUN marqueur → reprise garantie au prochain passage.
    await appendMessage({
      conversationId: job.conversationId,
      userId: job.userId,
      role: "assistant",
      content,
      generationStatus: "complete",
    });

    // 3) Artefact de livraison (carte vidéo du chat) : AUCUN mécanisme de mise
    // à jour d'artefact dans le dépôt (seulement addArtifactVersion) → on
    // crée UNIQUEMENT si l'artefact de lancement n'existe pas déjà (même
    // videoJobId ou videoProjectId) — la carte client se met à jour par
    // SSE/poll, jamais par le nombre d'artefacts. Listing impossible → on
    // s'abstient (jamais de doublon au hasard ; le message est le livrable).
    const existing = await listArtifacts(job.userId, { conversationId: job.conversationId, type: "video", limit: 200 }).catch(() => null);
    if (existing && !existing.some((a) => a.videoJobId === job.id || a.videoProjectId === job.projectId)) {
      await createArtifact({
        userId: job.userId,
        conversationId: job.conversationId,
        type: "video",
        title: job.title || "Vidéo Gen3ia",
        note: job.status === "completed" ? "Vidéo terminée" : job.status === "failed" ? "Production vidéo échouée" : "Production vidéo annulée",
        videoProjectId: job.projectId,
        videoJobId: job.id,
      });
    }

    // 4) Marqueur d'idempotence (best-effort) : accélère les passages suivants.
    // Son échec n'est PAS une perte : l'anti-doublon 1 couvre la reprise.
    await writeCheckpointSet(
      PRODUCTION_JOBS_COLLECTION,
      job.id,
      { chatDeliveredAt: nowIso(), updatedAt: nowIso() },
      job.userId,
    ).catch(() => undefined);
  } catch (deliveryError) {
    // Incident de livraison journalisé — le tick n'échoue JAMAIS à cause de
    // la livraison : le prochain passage (tick tardif, sweep, GET) re-livre.
    const detail = deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
    logger.warn(
      { jobId: job.id, conversationId: job.conversationId, error: detail },
      "video_delivery_failed",
    );
    await logSystem(job.projectId, `Livraison chat de la production ${job.id.slice(0, 8)} impossible (reprise automatique au prochain passage) : ${detail.slice(0, 200)}.`).catch(() => undefined);
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
  const stale = await queryJobDocs<VideoProductionJob>(PRODUCTION_JOBS_COLLECTION, "status", "processing");
  const now = Date.now();
  let requeued = 0;
  let failed = 0;
  for (const stored of stale) {
    const job = normalizeJobDoc(stored as Partial<ProductionJobWithResume>, stored.id);
    if (leaseActive(job, now)) continue;
    // Sans bail (document historique), l'ancienneté updatedAt tranche (2× bail).
    if (typeof job.leaseExpiresAt !== "number" || job.leaseExpiresAt <= 0) {
      const age = now - Date.parse(job.updatedAt || job.createdAt);
      if (!(Number.isFinite(age) && age > 2 * PRODUCTION_LEASE_MS)) continue;
    }
    const result = await failProductionJob(job, new Error("Échéance de traitement dépassée (worker interrompu) — reprise à l'étape courante."));
    if (result.status === "queued") requeued += 1;
    else failed += 1;
  }
  return { scanned: stale.length, requeued, failed };
}

/**
 * Continuation par SONDAGE : fait avancer d'UN tick un job en attente dans
 * la requête de polling (GET production) — la production avance même sans
 * QStash tant que le client garde la page ouverte. Le claim transactionnel
 * empêche les sondages concurrents de doubler un tick QStash.
 */
export async function maybeAdvancePendingProductionJob(jobId: string, options: { timeBudgetMs?: number } = {}): Promise<ProductionTickResult | null> {
  // Task 95-d — lecture via la couche résiliente (miroir chaud sous quota).
  const stored = await loadJobDoc<Partial<ProductionJobWithResume>>(PRODUCTION_JOBS_COLLECTION, jobId);
  if (!stored) return null;
  const job = normalizeJobDoc(stored, jobId);
  if (job.status === "queued") {
    return advanceProductionJob(jobId, { timeBudgetMs: options.timeBudgetMs });
  }
  if (job.status === "processing" && !leaseActive(job, Date.now())) {
    return advanceProductionJob(jobId, { timeBudgetMs: options.timeBudgetMs });
  }
  return null;
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
  const jobs = await queryJobDocs<VideoProductionJob>(PRODUCTION_JOBS_COLLECTION, "status", "queued", { orderField: "createdAt" });
  const now = Date.now();
  for (const candidate of jobs) {
    // Job en attente de backoff → pas encore réclamable (avancera à l'échéance).
    if (evaluateNextAttemptAtGuard(candidate, now).skip) continue;
    const outcome = await claimProductionJob(candidate.id).catch(() => null);
    if (outcome?.kind === "claimed") return outcome.job;
  }
  return null;
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

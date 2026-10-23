import "server-only";

/**
 * GEN3IA VIDEO AGENT — CONTRAT DU JOB DE PRODUCTION (module 20, partie 1).
 *
 * Feuille sans dépendance métier : constantes publiques, types du document
 * job `videoProductionJobs` et helpers PUR (progression pondérée, fenêtre de
 * lot sceneCursor, tolérance par scène Task 106-c, garde nextAttemptAt,
 * normalisation des documents historiques). Partagé par la file
 * (production-queue.ts), la machine d'étapes (production-stages.ts) et la
 * livraison chat (production-delivery.ts) — extrait de production-queue.ts
 * (Task 95-d / 106-c / 107-a, code déplacé tel quel).
 */

import type { VideoExportTarget, VideoProject, SubtitleStyleName, VideoEffectPreset } from "@/lib/video/types";
import type { SceneVideoTaskState } from "@/lib/video/scene-video-service";
import { computeStageProgress, nowIso } from "@/lib/video/queue-core";

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
export type ProductionJobWithResume = VideoProductionJob & { quotaFailures?: number };

/**
 * Progression d'un job de production (contrat 0..1) — interpolée DANS
 * l'étape courante : completed/total (scènes traitées, progression restituée
 * du rendu…) ; total = 0 → début d'étape (1 pour `done`).
 */
export function computeProductionProgress(stage: ProductionStage, completed: number, total: number): number {
  return computeStageProgress(PRODUCTION_STAGE_WEIGHTS, "done", stage, completed, total);
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
// Normalisation des documents job (compatibilité champs manquants)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Normalise un document job (compatibilité champs manquants). Task 95-d :
 * le compteur `quotaFailures` (hors contrat historique) transite tel quel.
 */
export function normalizeJobDoc(stored: Partial<ProductionJobWithResume>, id: string): ProductionJobWithResume {
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
export function isSceneFailureRecord(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "number");
}

/** Garde de forme des tâches vidéo vivantes (documents corrompus → ignorées). */
export function isSceneVideoTaskRecord(value: unknown): value is Record<string, SceneVideoTaskState> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (v) =>
      typeof v === "object" && v !== null &&
      typeof (v as SceneVideoTaskState).videoId === "string" && (v as SceneVideoTaskState).videoId.length > 0 &&
      typeof (v as SceneVideoTaskState).billingReference === "string" &&
      typeof (v as SceneVideoTaskState).seconds === "number",
  );
}

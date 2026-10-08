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
 *   documents job passent par la couche résiliente (miroir chaud Supabase),
 *   le claim bascule sur le miroir sous quota, et un incident QUOTA ne
 *   consomme PAS le budget de relance (backoff automatique, checkpoints
 *   conservés, aucune fausse notification d'échec).
 */

import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/observability/logger";
import { publishJsonDestination, type QStashPublishResult } from "@/lib/queue/qstash";
import { resolveJobOrigin } from "@/lib/queue/origin";
import { createProject, getOwnedProjectOrThrow, patchProject, logSystem } from "@/lib/video/project-service";
import { VideoProjectCreateSchema, DirectorBriefSchema, RenderRequestSchema } from "@/lib/video/security";
import { applyProductionPlan } from "@/lib/video/director-service";
import { generateScript } from "@/lib/video/script-service";
import { generateSceneImage } from "@/lib/video/image-bridge";
import { billImageGeneration, billTts } from "@/lib/video/credits";
import { resolvePreferredVoice, generateSceneNarration, attachRecordingAsNarration } from "@/lib/video/voice-service";
import { listAssets } from "@/lib/video/asset-service";
import { syncVoiceTrack, applyTimelinePatch } from "@/lib/video/timeline-service";
import { ensureMusicBed } from "@/lib/video/audio-engine";
import { isOwnedVideoKey } from "@/lib/video/storage";
import { startRenderJob, getJob } from "@/lib/video/render-queue";
import type { VideoExportTarget, VideoProject } from "@/lib/video/types";
import {
  claimJobViaFallback,
  classifyTickError,
  createJobDoc,
  loadJobDoc,
  maybeReconcileQuotaRecovery,
  queryJobDocs,
  resumePolicyFor,
  type ResumePolicy,
} from "@/lib/video/queue-resume";
import { firestoreUsable, writeCheckpointSet } from "@/lib/db/firestore-fallback";

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
  /** Formats dérivés à produire après le master (validés RenderRequestSchema). */
  derivedTargets?: VideoExportTarget[];
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
 * l'étape courante : completed/total (scènes traitées, progression miroir
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
}

export interface CreateVideoProductionJobResult {
  jobId: string;
  projectId: string;
  status: "queued";
  stage: ProductionStage;
  /** Mode de continuation effectif : QStash si configuré, sinon sondage. */
  queueMode: "qstash" | "poll";
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
  const brief = DirectorBriefSchema.parse({ brief: params.prompt }).brief;
  const title = params.title?.trim() || deriveTitle(brief);

  // Même validation que POST /api/video/projects (les clés inconnues comme
  // voiceEnabled/subtitlesEnabled sont retirées par le schéma — elles
  // restent portées par job.options pour les étapes voix/rendu).
  const projectInput = VideoProjectCreateSchema.parse({
    ...(params.options ?? {}),
    title,
    description: params.options?.audience ? `Brief : ${brief.slice(0, 1500)}` : brief.slice(0, 2000),
  });
  const project = await createProject(params.userId, projectInput);

  const derivedTargets = params.options?.derivedTargets
    ? RenderRequestSchema.parse({ derivedTargets: params.options.derivedTargets }).derivedTargets
    : [];

  const jobId = randomUUID();
  const now = nowIso();
  const job: VideoProductionJob = {
    id: jobId,
    userId: params.userId,
    projectId: project.id,
    prompt: brief,
    title,
    options: { ...(params.options ?? {}), derivedTargets },
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
  // Task 95-d — création via la couche résiliente (miroir chaud Supabase :
  // le job existe dès sa création, même Firestore sous quota). PAS de
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
    await logSystem(project.id, `Continuation QStash indisponible (${published.message.slice(0, 200)}) — avancement par sondage du studio.`).catch(() => undefined);
  }

  return { jobId, projectId: project.id, status: "queued", stage: "project", queueMode: published.ok ? "qstash" : "poll" };
}

// ────────────────────────────────────────────────────────────────────────────
// Publication QStash (même pattern corrigé que le rendu)
// ────────────────────────────────────────────────────────────────────────────

export function productionTickUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/video/worker/production-tick`;
}

/**
 * Publie un tick de production via le pattern partagé de lib/queue/qstash.
 * ORIGINE CANONIQUE (fix CodeQL request-forgery) : résolue en interne depuis
 * GEN3IA_APP_ORIGIN (allowlist serveur) — jamais depuis une origine de
 * requête. « unconfigured » couvre QStash absent ET origine non résolue
 * (la continuation par sondage prend le relais).
 */
export async function publishProductionTick(jobId: string, delaySeconds = 1): Promise<QStashPublishResult> {
  const resolved = resolveJobOrigin();
  if (!resolved.ok) return { ok: false, mode: "unconfigured" } as const;
  return publishJsonDestination(productionTickUrl(resolved.origin), JSON.stringify({ jobId }), { delaySeconds });
}

async function publishTickAndLog(job: Pick<VideoProductionJob, "id" | "projectId">, delaySeconds = 0): Promise<boolean> {
  const published = await publishProductionTick(job.id, delaySeconds);
  if (!published.ok && published.mode === "error") {
    await logSystem(job.projectId, `Continuation QStash échouée (${published.message.slice(0, 200)}) — reprise par sondage du studio.`).catch(() => undefined);
  }
  return published.ok;
}

// ────────────────────────────────────────────────────────────────────────────
// Claim transactionnel + bail (miroir exact du rendu)
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
    ...(Array.isArray(stored.warnings) ? { warnings: stored.warnings.filter((w): w is string => typeof w === "string") } : {}),
    ...(typeof stored.nextAttemptAt === "string" ? { nextAttemptAt: stored.nextAttemptAt } : {}),
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

async function claimProductionJob(jobId: string): Promise<ProductionClaimOutcome> {
  // Task 106-fix — COHÉRENCE DE RÉGIME (miroir du fix render-queue) : si le
  // disjoncteur quota Firestore est OUVERT, les checkpoints de scène
  // (sceneCursor/sceneFailures via saveJobDoc) partent au MIROIR tandis
  // qu'une transaction Firestore réussirait encore — le claim relirait
  // l'ancien document Firestore et re-trerait les mêmes scènes. Bascule du
  // claim ENTIER vers le miroir dès l'ouverture du disjoncteur.
  if (!firestoreUsable()) {
    return claimProductionViaMirror(jobId);
  }
  // Task 95-d — le claim reste TRANSACTIONNEL sur Firestore ; en cas d'erreur
  // de QUOTA, bascule sur un claim ATOMIQUE sur la ligne miroir Supabase
  // (failover en fin de fonction). Transitoire/fatal : propagation inchangée.
  try {
    return await adminDb.runTransaction(async (tx) => {
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
  } catch (error) {
    // Task 95-d — FAILOVER QUOTA : Firestore sous quota (RESOURCE_EXHAUSTED)
    // → claim ATOMIQUE sur la ligne miroir Supabase (bail + statut posés dans
    // un seul UPDATE conditionnel — deux workers ne peuvent pas gagner tous
    // deux). Statuts réclamables = exactement les conditions de la
    // transaction : « queued », ou « processing » au bail libre/expiré (le
    // filtre de bail est exprimé dans claimJobViaFallback).
    if (classifyTickError(error) !== "quota") throw error;
    return claimProductionViaMirror(jobId, error);
  }
}

/**
 * Task 106-fix — claim ATOMIQUE miroir (partagé par le disjoncteur ouvert et
 * le failover quota) : bail + statut posés dans un seul UPDATE conditionnel
 * — deux workers ne peuvent pas gagner tous deux.
 */
async function claimProductionViaMirror(jobId: string, originalError?: unknown): Promise<ProductionClaimOutcome> {
  const now = Date.now();
  const leaseOwner = `${jobId}:${randomUUID()}`;
  const leaseExpiresAt = now + PRODUCTION_LEASE_MS;
  const expiresAtIso = new Date(leaseExpiresAt).toISOString();
  // `attempts` n'est PAS patché (compteur informatif) : +1 appliqué sur la
  // valeur miroir lue, comme le fait la transaction.
  const payload = await claimJobViaFallback(
    PRODUCTION_JOBS_COLLECTION,
    jobId,
    { owner: leaseOwner, expiresAtIso },
    ["queued", "processing"],
    { status: "processing", deadlineAt: expiresAtIso, updatedAt: nowIso() },
  );
  // Miroir absent, bail déjà pris ou Supabase indisponible : propagation
  // (erreur de quota d'origine le cas échéant — le tick sera republié).
  if (!payload) {
    throw originalError ?? new Error(`Claim miroir impossible pour ${jobId} (absent ou bail actif).`);
  }
  const stored = payload as unknown as Partial<ProductionJobWithResume>;
  const job = normalizeJobDoc(stored, jobId);
  const previousStatus = job.status;
  job.status = "processing";
  job.leaseOwner = leaseOwner;
  job.leaseExpiresAt = leaseExpiresAt;
  job.attempts = (typeof stored.attempts === "number" ? stored.attempts : 0) + 1;
  return { kind: "claimed", job, previousStatus } as const;
}

async function releaseLease(jobId: string): Promise<void> {
  // Task 95-d — écriture via la couche résiliente (miroir chaud sous quota).
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
  // Task 95-d — écriture via la couche résiliente (miroir chaud sous quota).
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
  // Task 95-d — écriture via la couche résiliente (miroir chaud sous quota).
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

/**
 * ASSETS : visuels de scènes par lots de ≤ ASSET_BATCH_SIZE par tick
 * (per-scene via Image Bridge + Consistency Engine, réutilise les images
 * existantes), sceneCursor checkpoint après CHAQUE scène — reprise là où
 * le tick s'est arrêté. Facturation existante honorée : billImageGeneration
 * sur les images NOUVELLEMENT générées (les réutilisations ne coûtent rien).
 *
 * Task 106-c — TOLÉRANCE PAR SCÈNE : chaque scène est traitée dans son
 * propre try/catch. Un échec FATAL de génération (moteur d'image, HTTP,
 * plafond projet…) est absorbé : compteur sceneFailures incrémenté, warning
 * FR consignée, curseur avancé, le lot CONTINUE. Sous MAX_SCENE_FAILURES la
 * scène est retentée au prochain tick (curseur ramené en fin d'étape) ; à
 * MAX elle est définitivement ignorée — le rendu la saute déjà (pas de
 * segment sans image). Les incidents QUOTA/TRANSITOIRES ne sont PAS des
 * fautes de scène : ils remontent au régime de reprise du tick (backoff,
 * budget intact).
 */
async function stageAssets(job: VideoProductionJob, timeBudgetMs?: number): Promise<ProductionStageResult> {
  let project = await getOwnedProjectOrThrow(job.userId, job.projectId);
  if (!project.script) throw new Error("Scénario absent à l'étape des visuels.");
  const scenes = project.script.scenes;
  if (scenes.length === 0) throw new Error("Scénario vide : aucune scène à illustrer.");

  const deadlineMs = typeof timeBudgetMs === "number" && timeBudgetMs > 0 ? Date.now() + timeBudgetMs : null;
  const window = nextAssetWindow(scenes, job.sceneCursor, ASSET_BATCH_SIZE);
  let generated = 0;
  // Task 106-c — état de tolérance (persisté sur le job à chaque checkpoint).
  let sceneFailures = job.sceneFailures ?? {};
  let warnings = job.warnings ?? [];
  // Task 106-c — détection SYSTÉMIQUE : aucune scène du lot n'aboutit →
  // incident global (moteur de visuels indisponible…) → l'ancien régime de
  // reprise du tick prévaut (re-file sous budget, échec définitif au budget)
  // au lieu de la tolérance par scène qui ne doit pas masquer une panne.
  let succeededInBatch = 0;
  let fatalInBatch = 0;
  let firstFatalError: unknown = null;

  for (const scene of window.batch) {
    if (deadlineMs !== null && Date.now() >= deadlineMs) break;
    const sceneIndex = scenes.findIndex((s) => s.id === scene.id);
    const failureKey = sceneFailureKey("assets", scene.id);
    if (shouldSkipScene(sceneFailures, failureKey)) {
      // Déjà définitivement ignorée : sautée sans re-tenter (curseur avance).
      job.sceneCursor = sceneIndex + 1;
      continue;
    }
    try {
      const result = await generateSceneImage({ userId: job.userId, project, scene });
      if (result.generated) {
        generated += 1;
        // La bible évolue à chaque référence établie : la scène suivante
        // bénéficie des références fraîches (même comportement que le lot client).
        project = await getOwnedProjectOrThrow(job.userId, job.projectId);
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
          label: "image",
          sceneNumber: sceneIndex + 1,
          failures: sceneFailures[failureKey],
          permanentlyIgnored,
          cause: error instanceof Error ? error.message : String(error),
        }),
      );
      fatalInBatch += 1;
      if (firstFatalError === null) firstFatalError = error;
      // Curseur avancé SANS checkpoint immédiat : en cas d'échec systémique
      // (tout le lot), la ré-file legacy doit reprendre au DÉBUT du lot.
      job.sceneCursor = sceneIndex + 1;
      continue;
    }
    job.sceneCursor = sceneIndex + 1;
    // Task 95-d — checkpoint via la couche résiliente (miroir chaud) —
    // porte AUSSI sceneFailures/warnings (tolérance par scène persistée).
    await writeCheckpointSet(
      PRODUCTION_JOBS_COLLECTION,
      job.id,
      {
        sceneCursor: job.sceneCursor,
        progress: computeProductionProgress("assets", job.sceneCursor, scenes.length),
        sceneFailures,
        warnings,
        updatedAt: nowIso(),
      },
      job.userId,
    );
  }

  // Task 106-c — SYSTÉMIQUE : aucune réussite dans le lot + au moins un
  // échec fatal → on RENVOIE la première erreur fatale : le régime de
  // reprise du tick (failProductionJob) la traite exactement comme avant
  // (re-file 20 s sous budget / échec définitif + notification au budget).
  if (fatalInBatch > 0 && succeededInBatch === 0) {
    throw firstFatalError instanceof Error ? firstFatalError : new Error(String(firstFatalError));
  }

  // Task 106-c — TOLÉRANCE PARTIELLE : au moins une scène du lot a abouti →
  // les échecs fatals (sans checkpoint individuel) sont persistés ici.
  if (fatalInBatch > 0) {
    await writeCheckpointSet(
      PRODUCTION_JOBS_COLLECTION,
      job.id,
      {
        sceneCursor: job.sceneCursor,
        progress: computeProductionProgress("assets", job.sceneCursor, scenes.length),
        sceneFailures,
        warnings,
        updatedAt: nowIso(),
      },
      job.userId,
    );
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
    return {
      action: "advance",
      detail: `${scenes.length} visuel(s) prêt(s) (${generated} généré(s)${ignored > 0 ? `, ${ignored} scène(s) ignorée(s)` : ""}).`,
    };
  }
  return { action: "stay", detail: `${job.sceneCursor}/${scenes.length} visuels traités.` };
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
 */
async function stageVoice(job: VideoProductionJob, timeBudgetMs?: number): Promise<ProductionStageResult> {
  const project = await getOwnedProjectOrThrow(job.userId, job.projectId);
  if (!project.script) throw new Error("Scénario absent à l'étape de la voix.");
  const scenes = project.script.scenes;

  if (job.options?.voiceEnabled === false) {
    return { action: "advance", detail: "Narration désactivée — vidéo muette assumée." };
  }
  const voice = await resolvePreferredVoice(job.userId, project);
  if (!voice) {
    return { action: "advance", detail: "Aucune voix configurée — vidéo muette assumée (narrations ajoutables depuis le studio)." };
  }

  // Task 106-c — narrations déjà prêtes (idempotence des reprises : jamais
  // de double synthèse / double facturation lors des retentes par scène).
  const existingNarrations = await listAssets(job.userId, job.projectId, "audio_narration");
  const narratedSceneIds = new Set(existingNarrations.filter((a) => a.sceneId).map((a) => a.sceneId!));

  const deadlineMs = typeof timeBudgetMs === "number" && timeBudgetMs > 0 ? Date.now() + timeBudgetMs : null;
  const window = nextAssetWindow(scenes, job.sceneCursor, ASSET_BATCH_SIZE);
  // Task 106-c — état de tolérance (persisté sur le job à chaque checkpoint).
  let sceneFailures = job.sceneFailures ?? {};
  let warnings = job.warnings ?? [];
  // Task 106-c — détection SYSTÉMIQUE (même contrat que stageAssets).
  let succeededInBatch = 0;
  let fatalInBatch = 0;
  let firstFatalError: unknown = null;

  for (const scene of window.batch) {
    if (deadlineMs !== null && Date.now() >= deadlineMs) break;
    const sceneIndex = scenes.findIndex((s) => s.id === scene.id);
    const failureKey = sceneFailureKey("voice", scene.id);
    if (shouldSkipScene(sceneFailures, failureKey)) {
      // Définitivement ignorée (vidéo muette sur cette scène) : on saute.
      job.sceneCursor = sceneIndex + 1;
      continue;
    }
    try {
      if (narratedSceneIds.has(scene.id)) {
        // Déjà prête : no-op (idempotence — le checkpoint du curseur suffit).
        succeededInBatch += 1;
      } else if (voice.origin === "recording" && voice.sampleR2Key && isOwnedVideoKey(job.userId, voice.sampleR2Key)) {
        // Voie A : enregistrement utilisateur (usage direct de l'échantillon).
        await attachRecordingAsNarration({
          userId: job.userId,
          projectId: job.projectId,
          sceneId: scene.id,
          sampleR2Key: voice.sampleR2Key,
        });
        succeededInBatch += 1;
      } else {
        // Voie B : synthèse ElevenLabs facturée au caractère réel.
        const narration = await generateSceneNarration({
          userId: job.userId,
          projectId: job.projectId,
          sceneId: scene.id,
          narration: scene.narration,
          voice,
        });
        if (narration.charactersUsed > 0) {
          await billTts(job.userId, job.projectId, narration.charactersUsed);
        }
        succeededInBatch += 1;
      }
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
      // Curseur avancé SANS checkpoint immédiat (détection systémique ensuite).
      job.sceneCursor = sceneIndex + 1;
      continue;
    }
    job.sceneCursor = sceneIndex + 1;
    // Task 95-d — checkpoint via la couche résiliente (miroir chaud) —
    // porte AUSSI sceneFailures/warnings (tolérance par scène persistée).
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

  // Task 106-c — SYSTÉMIQUE : aucune narration du lot n'aboutit → régime de
  // reprise du tick (identique à l'étape assets).
  if (fatalInBatch > 0 && succeededInBatch === 0) {
    throw firstFatalError instanceof Error ? firstFatalError : new Error(String(firstFatalError));
  }

  // Task 106-c — TOLÉRANCE PARTIELLE : persistance des échecs fatals accumulés.
  if (fatalInBatch > 0) {
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
    // Task 106-c — TOUTES les narrations définitivement abandonnées.
    return {
      action: "terminal-failed",
      message: `Production échouée : les ${scenes.length} narration(s) ont été définitivement abandonnées après ${MAX_SCENE_FAILURES} échecs de synthèse vocale. Vérifiez la configuration de la voix ou réessayez plus tard.`,
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
  const project = await getOwnedProjectOrThrow(job.userId, job.projectId);
  // Option subtitlesEnabled:false → sous-titres coupés sur la timeline.
  if (job.options?.subtitlesEnabled === false && project.timeline?.captions?.enabled) {
    await patchProject(job.userId, job.projectId, {
      timeline: { ...project.timeline, captions: { ...project.timeline.captions, enabled: false } },
    });
  }
  const derivedTargets = job.options?.derivedTargets
    ? RenderRequestSchema.parse({ derivedTargets: job.options.derivedTargets }).derivedTargets
    : [];
  const render = await startRenderJob({ userId: job.userId, projectId: job.projectId, derivedTargets });
  // Rattaché AVANT le passage à l'étape done (visible même si le tick meurt ici).
  // Task 95-d — écriture via la couche résiliente (miroir chaud sous quota).
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
 * bail (failover miroir Supabase sous quota — Task 95-d) ; en fin de tick
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
        // Restauration impossible (quota aussi côté miroir) : le job reste
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
    // miroir — la route tick republiera.)
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
    // Task 95-d — écriture via la couche résiliente (miroir chaud sous quota).
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
    // Task 95-d — écriture via la couche résiliente (miroir chaud sous quota).
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
 * (quota aussi côté miroir — Supabase indisponible), on journalise et on
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
    // La ré-écriture elle-même a échoué (quota aussi côté miroir — Supabase
    // indisponible) : on journalise et on PROPAGE — la route tick ré-enfilera
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
  // Task 95-d — lecture via la couche résiliente (miroir chaud sous quota).
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
  // Task 95-d — réconciliation opportuniste (throttle 5 min process-local) :
  // quand le disjoncteur est refermé, ré-imbrique les lignes miroir dans
  // Firestore. Ne lève jamais.
  await maybeReconcileQuotaRecovery(25);
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

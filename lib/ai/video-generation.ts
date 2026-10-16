import "server-only";

/**
 * Génération de VIDEOS réelle via Agnes AI (apihub.agnes-ai.com) — Task 154.
 *
 * - API asynchrone compatible OpenAI Videos : POST /v1/videos (création de
 *   tâche) puis GET /agnesapi?video_id=<ID>&model_name=agnes-video-2.5
 *   (progression + URL du MP4 une fois « completed »).
 * - Modèle par défaut : agnes-video-2.5 (text-to-video, contrôle par
 *   keyframe first/last frame, références multimodales).
 * - La clé vit UNIQUEMENT côté serveur (AGNES_API_KEY — la même que les
 *   images, déjà configurée en production).
 *
 * Référence : https://wiki.agnes-ai.com/en/docs/agnes-video-25.md
 * Tarifs (par seconde de sortie) : 720P $0.025, 1080P/1K $0.040, 2K $0.055.
 */

export const AGNES_VIDEO_MODEL = process.env.AGNES_VIDEO_MODEL || "agnes-video-2.5";

const AGNES_API_BASE = process.env.AGNES_API_BASE || "https://apihub.agnes-ai.com/v1";
const AGNES_POLL_BASE = process.env.AGNES_API_BASE?.replace(/\/v1\/?$/, "") || "https://apihub.agnes-ai.com";

/** Budget de polling : une génération nominale prend 30 s–3 min (720P plus rapide). Lu paresseusement (testable). */
function pollTimeoutMs(): number {
  return numberEnv("GEN3IA_VIDEO_POLL_TIMEOUT_MS", 600_000);
}
/** Intervalle de sondage (2 s — resserrable en test via l'environnement). */
function pollIntervalMs(): number {
  return numberEnv("GEN3IA_VIDEO_POLL_INTERVAL_MS", 2_000);
}

/** Tailles/ratios réellement supportés par l'API (doc officielle). */
export const VIDEO_SIZES = ["720P", "1080P", "1K", "2K"] as const;
export type VideoSize = (typeof VIDEO_SIZES)[number];
export const VIDEO_ASPECT_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];

/** Durée d'un clip générable (bornes de l'API). */
export const MIN_CLIP_SECONDS = 4;
export const MAX_CLIP_SECONDS = 12;

export interface GeneratedVideo {
  videoUrl: string;
  model: string;
  videoId: string;
  taskId: string;
  seconds: number;
  size: VideoSize;
  latencyMs: number;
}

export type VideoGenerationMode = "text" | "keyframe" | "reference";

export interface CreateVideoTaskInput {
  prompt: string;
  mode: VideoGenerationMode;
  seconds: number;
  size: VideoSize;
  aspectRatio?: VideoAspectRatio;
  seed?: number;
  /** Mode keyframe : image de PREMIÈRE frame (URL publique). */
  firstFrameUrl?: string;
  /** Mode keyframe : image de DERNIÈRE frame (URL publique). */
  lastFrameUrl?: string;
  /** Mode reference : images de référence (URLs publiques). */
  referenceImageUrls?: string[];
}

export class VideoGenerationError extends Error {
  code: "NOT_CONFIGURED" | "UPSTREAM_ERROR" | "TIMEOUT" | "INVALID_PROMPT" | "INVALID_MEDIA" | "RATE_LIMITED";
  httpStatus?: number;

  constructor(
    code: VideoGenerationError["code"],
    message: string,
    options?: { httpStatus?: number },
  ) {
    super(message);
    this.code = code;
    this.name = "VideoGenerationError";
    if (typeof options?.httpStatus === "number") this.httpStatus = options.httpStatus;
  }
}

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** La génération de vidéos n'est disponible que si la clé Agnes est configurée. */
export function isVideoGenerationEnabled(): boolean {
  return Boolean(process.env.AGNES_API_KEY);
}

/**
 * Task 154 — activation métier des clips IA par scène. Faux uniquement si
 * l'opérateur coupe explicitement le levier (GEN3IA_VIDEO_CLIPS_ENABLED=0) :
 * la qualité « vraie vidéo IA » est le comportement attendu par défaut.
 */
export function areSceneClipsEnabled(): boolean {
  const raw = process.env.GEN3IA_VIDEO_CLIPS_ENABLED;
  if (raw === undefined) return true;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

/** Mapping résolution projet Gen3ia → palier de sortie Agnes Video. */
export function videoSizeForResolution(resolution: "480p" | "720p" | "1080p" | "1440p" | "4K"): VideoSize {
  switch (resolution) {
    case "480p":
    case "720p":
      return "720P";
    case "1080p":
      return "1080P";
    case "1440p":
    case "4K":
      return "2K";
  }
}

/** Mapping ratio projet → ratio supporté par l'API vidéo (4:5 → 3:4 vertical proche). */
export function videoAspectRatioFor(aspect: "16:9" | "9:16" | "1:1" | "4:5" | "21:9"): VideoAspectRatio {
  if (aspect === "4:5") return "3:4";
  return aspect;
}

/**
 * Coût externe EUR d'une génération (par seconde facturée — la durée de
 * sortie est celle demandée à la création ; entrée keyframe = image unique
 * gratuite dans l'allocation de 5 images).
 */
export function agnesVideoCostEur(seconds: number, size: VideoSize): number {
  const perSecond: Record<VideoSize, number> = {
    "720P": numberEnv("COST_AGNES_VIDEO_720P_EUR_PER_SEC", 0.025),
    "1080P": numberEnv("COST_AGNES_VIDEO_1080P_EUR_PER_SEC", 0.04),
    "1K": numberEnv("COST_AGNES_VIDEO_1K_EUR_PER_SEC", 0.04),
    "2K": numberEnv("COST_AGNES_VIDEO_2K_EUR_PER_SEC", 0.055),
  };
  const secs = Math.max(0, seconds);
  return secs * perSecond[size];
}

/** Crée une tâche de génération vidéo et renvoie son identifiant. */
export async function createVideoTask(input: CreateVideoTaskInput): Promise<{
  videoId: string;
  taskId: string;
  status: string;
}> {
  const apiKey = process.env.AGNES_API_KEY;
  if (!apiKey) {
    throw new VideoGenerationError(
      "NOT_CONFIGURED",
      "La génération de vidéos n'est pas configurée sur cette plateforme (AGNES_API_KEY manquante).",
    );
  }
  const prompt = input.prompt.trim();
  if (prompt.length < 3) {
    throw new VideoGenerationError("INVALID_PROMPT", "Prompt vidéo trop court.");
  }
  const seconds = Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, Math.round(input.seconds)));
  if (input.mode === "keyframe" && !input.firstFrameUrl && !input.lastFrameUrl) {
    throw new VideoGenerationError("INVALID_MEDIA", "Le mode keyframe exige first_frame ou last_frame.");
  }
  if (input.mode === "reference" && (!input.referenceImageUrls || input.referenceImageUrls.length === 0)) {
    throw new VideoGenerationError("INVALID_MEDIA", "Le mode reference exige au moins une image de référence.");
  }

  const body: Record<string, unknown> = {
    model: AGNES_VIDEO_MODEL,
    prompt,
    seconds: String(seconds),
    mode: input.mode,
    size: input.size,
    aspect_ratio: input.aspectRatio ?? "16:9",
  };
  if (typeof input.seed === "number" && Number.isFinite(input.seed)) body.seed = Math.trunc(input.seed);
  if (input.mode === "keyframe") {
    if (input.firstFrameUrl) body.first_frame = input.firstFrameUrl;
    if (input.lastFrameUrl) body.last_frame = input.lastFrameUrl;
  } else if (input.mode === "reference") {
    body.images = input.referenceImageUrls!.slice(0, 8);
  }

  const response = await fetch(`${AGNES_API_BASE}/videos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new VideoGenerationError(
      response.status === 429 ? "RATE_LIMITED" : response.status === 400 ? "INVALID_PROMPT" : "UPSTREAM_ERROR",
      `Agnes Video : HTTP ${response.status} — ${extractErrorMessage(payload)}`,
      { httpStatus: response.status },
    );
  }
  const videoId = typeof payload?.video_id === "string" ? payload.video_id : "";
  const taskId = typeof payload?.task_id === "string" ? payload.task_id : "";
  if (!videoId) {
    throw new VideoGenerationError("UPSTREAM_ERROR", "Agnes Video : réponse sans video_id.");
  }
  return { videoId, taskId: taskId || videoId, status: typeof payload?.status === "string" ? payload.status : "queued" };
}

interface VideoTaskStatus {
  status: string;
  progress: number;
  url?: string;
  seconds?: number;
  error?: { message?: string } | null;
}

/** Interroge l'état d'une tâche (GET /agnesapi — formulaire recommandé). */
export async function retrieveVideoTask(videoId: string): Promise<VideoTaskStatus> {
  const apiKey = process.env.AGNES_API_KEY;
  if (!apiKey) {
    throw new VideoGenerationError("NOT_CONFIGURED", "AGNES_API_KEY manquante.");
  }
  const url = `${AGNES_POLL_BASE}/agnesapi?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(AGNES_VIDEO_MODEL)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new VideoGenerationError(
      response.status === 429 ? "RATE_LIMITED" : "UPSTREAM_ERROR",
      `Agnes Video (sondage) : HTTP ${response.status} — ${extractErrorMessage(payload)}`,
      { httpStatus: response.status },
    );
  }
  return {
    status: typeof payload?.status === "string" ? payload.status : "unknown",
    progress: Number(payload?.progress ?? 0),
    url: typeof payload?.url === "string" && payload.url.startsWith("http") ? payload.url : undefined,
    seconds: Number(payload?.seconds ?? 0) || undefined,
    error: (payload?.error as { message?: string } | null | undefined) ?? undefined,
  };
}

/**
 * Cycle complet : création + polling jusqu'à « completed ». Backoff doux sur
 * les 429 (rate-limit de sondage), timeout global configurable.
 */
export async function generateVideo(input: CreateVideoTaskInput): Promise<GeneratedVideo> {
  const startedAt = Date.now();
  const { videoId, taskId } = await createVideoTask(input);

  const timeoutMs = pollTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  let intervalMs = pollIntervalMs();
  let lastProgress = 0;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let status: VideoTaskStatus;
    try {
      status = await retrieveVideoTask(videoId);
    } catch (error) {
      if (error instanceof VideoGenerationError && error.code === "RATE_LIMITED") {
        intervalMs = Math.min(intervalMs * 2, 10_000); // backoff, on ne jette pas la tâche
        continue;
      }
      throw error;
    }
    lastProgress = status.progress;
    if (status.status === "failed") {
      throw new VideoGenerationError(
        "UPSTREAM_ERROR",
        `Agnes Video : génération échouée — ${status.error?.message ?? "raison inconnue"}`,
      );
    }
    if (status.status === "completed" && status.url) {
      return {
        videoUrl: status.url,
        model: AGNES_VIDEO_MODEL,
        videoId,
        taskId,
        seconds: status.seconds ?? Math.round(input.seconds),
        size: input.size,
        latencyMs: Date.now() - startedAt,
      };
    }
  }
  throw new VideoGenerationError(
    "TIMEOUT",
    `Agnes Video : pas de résultat après ${Math.round(timeoutMs / 1000)} s (dernière progression ${lastProgress} %).`,
  );
}

/** Résultat du sondage borné d'une tâche existante. */
export interface AwaitVideoTaskResult {
  status: "completed" | "pending" | "failed";
  videoUrl?: string;
  seconds?: number;
  error?: string;
  lastProgress: number;
}

/**
 * REPRISE INTER-TICKS — sonde une tâche DÉJÀ CRÉÉE jusqu'à terminaison
 * (completed/failed) OU échéance de l'appelant. `pending` = échéance atteinte
 * SANS terminaison : la tâche vit toujours côté Agnes, l'appelant la re-sonde
 * au tick suivant SANS re-générer (idempotence économique : jamais deux
 * coûts fournisseur pour une même scène). 429 → backoff doux, hoquets réseau
 * tolérés jusqu'à l'échéance.
 */
export async function awaitVideoTask(params: {
  videoId: string;
  /** Échéance absolue (Date.now()) ; défaut = timeout global du client. */
  deadlineMs?: number;
}): Promise<AwaitVideoTaskResult> {
  const deadline = typeof params.deadlineMs === "number" && params.deadlineMs > 0
    ? params.deadlineMs
    : Date.now() + pollTimeoutMs();
  let intervalMs = pollIntervalMs();
  let lastProgress = 0;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let status: VideoTaskStatus;
    try {
      status = await retrieveVideoTask(params.videoId);
    } catch (error) {
      if (error instanceof VideoGenerationError && error.code === "RATE_LIMITED") {
        intervalMs = Math.min(intervalMs * 2, 10_000);
        continue;
      }
      continue; // hoquet réseau/5xx : re-sondage tant que l'échéance tient
    }
    lastProgress = status.progress;
    if (status.status === "failed") {
      return {
        status: "failed",
        error: `Agnes Video : génération échouée — ${status.error?.message ?? "raison inconnue"}`,
        lastProgress,
      };
    }
    if (status.status === "completed" && status.url) {
      return { status: "completed", videoUrl: status.url, seconds: status.seconds, lastProgress };
    }
  }
  return { status: "pending", lastProgress };
}

/**
 * Indisponibilité technique (pour repli automatique « résultat plutôt
 * qu'échec ») : clé absente, 5xx, 429 persistant, timeout de génération.
 * Les erreurs de prompt/média (400) ne sont PAS des indisponibilités.
 */
export function isVideoUnavailableError(error: unknown): boolean {
  if (!(error instanceof VideoGenerationError)) return false;
  return error.code === "NOT_CONFIGURED" || error.code === "UPSTREAM_ERROR" || error.code === "TIMEOUT" || error.code === "RATE_LIMITED";
}

function extractErrorMessage(payload: Record<string, unknown> | null): string {
  const nested = payload?.error as { message?: string } | undefined;
  const message = nested?.message ?? (typeof payload?.message === "string" ? payload.message : "");
  return (message || "réponse invalide").slice(0, 300);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

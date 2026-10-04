import "server-only";

/**
 * GEN3IA VIDEO AGENT — sécurité des opérations coûteuses (spec §28).
 *
 * L'agent peut lancer des opérations coûteuses : chaque surface est donc
 * encadrée par des quotas bornés (variables d'environnement, défauts
 * conservateurs), une validation stricte des médias et une exécution
 * FFmpeg en bac à sable (protocoles fichier uniquement, timeout, taille
 * de sortie plafonnée, annulation, nettoyage).
 *
 * Zéro simplification : ce module est la source unique appliquée à la
 * fois par les routes API et par le worker de rendu.
 */

import { z } from "zod";

// ────────────────────────────────────────────────────────────────────────────
// Quotas (limites de durée, résolution, concurrence)
// ────────────────────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const VIDEO_LIMITS = {
  /** Projets actifs simultanés par utilisateur (hors archivés). */
  maxActiveProjects: envInt("VIDEO_MAX_ACTIVE_PROJECTS", 12),
  /** Rendus concurrents par utilisateur. */
  maxConcurrentRenders: envInt("VIDEO_MAX_CONCURRENT_RENDERS", 2),
  /** Durée cible maximale (60 min par défaut — Long Video Engine). */
  maxDurationSec: envInt("VIDEO_MAX_DURATION_SEC", 3600),
  /** Durée minimale utile. */
  minDurationSec: 10,
  /** Scènes maximales par projet. */
  maxScenes: envInt("VIDEO_MAX_SCENES", 400),
  /** Résolution maximale (4K possible si infrastructure le permet). */
  maxResolution: ["480p", "720p", "1080p", "1440p", "4K"] as const,
  /** Taille maximale d'un média importé/enregistré (alignée PJ : 50 Mo). */
  maxMediaBytes: envInt("VIDEO_MAX_MEDIA_BYTES", 50 * 1024 * 1024),
  /** Taille maximale d'un rendu final (4K 60 min ~ plafond raisonnable). */
  maxRenderBytes: envInt("VIDEO_MAX_RENDER_BYTES", 8 * 1024 * 1024 * 1024),
  /** Images générées maximum par projet. */
  maxGeneratedImages: envInt("VIDEO_MAX_GENERATED_IMAGES", 600),
  /** Caractères ElevenLabs maximum par projet. */
  maxTtsCharacters: envInt("VIDEO_MAX_TTS_CHARACTERS", 400_000),
} as const;

export const RESOLUTION_RANK: Record<string, number> = {
  "480p": 1,
  "720p": 2,
  "1080p": 3,
  "1440p": 4,
  "4K": 5,
};

export function assertDurationAllowed(targetDurationSec: number): void {
  if (!Number.isFinite(targetDurationSec)) throw new VideoQuotaError("Durée invalide.");
  if (targetDurationSec < VIDEO_LIMITS.minDurationSec) {
    throw new VideoQuotaError(`La durée minimale est de ${VIDEO_LIMITS.minDurationSec} secondes.`);
  }
  if (targetDurationSec > VIDEO_LIMITS.maxDurationSec) {
    throw new VideoQuotaError(
      `La durée maximale est de ${Math.round(VIDEO_LIMITS.maxDurationSec / 60)} minutes (Long Video Engine : les chapitres sont rendus par segments).`,
    );
  }
}

export function assertResolutionAllowed(resolution: string): void {
  const max = VIDEO_LIMITS.maxResolution[VIDEO_LIMITS.maxResolution.length - 1];
  if (!(resolution in RESOLUTION_RANK)) throw new VideoQuotaError(`Résolution inconnue : ${resolution}.`);
  if (RESOLUTION_RANK[resolution] > RESOLUTION_RANK[max]) {
    throw new VideoQuotaError(`Résolution ${resolution} au-delà du plafond plateforme (${max}).`);
  }
}

export class VideoQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoQuotaError";
  }
}

/** Types MIME acceptés à l'import / enregistrement (contrôle des formats). */
export const ACCEPTED_MEDIA_TYPES: Record<string, readonly string[]> = {
  image: ["image/png", "image/jpeg", "image/webp"],
  video: ["video/mp4", "video/webm", "video/quicktime"],
  audio: ["audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/webm", "audio/ogg", "audio/opus", "audio/flac"],
};

export function assertMediaTypeAllowed(kind: "image" | "video" | "audio", contentType: string): void {
  const allowed = ACCEPTED_MEDIA_TYPES[kind];
  if (!allowed.includes(contentType)) {
    throw new VideoQuotaError(`Format ${contentType} non autorisé (${kind} : ${allowed.join(", ")}).`);
  }
}

export function assertMediaSizeAllowed(sizeBytes: number, kind: "image" | "video" | "audio" | "render"): void {
  const cap =
    kind === "render"
      ? VIDEO_LIMITS.maxRenderBytes
      : VIDEO_LIMITS.maxMediaBytes;
  if (sizeBytes <= 0) throw new VideoQuotaError("Fichier vide.");
  if (sizeBytes > cap) {
    throw new VideoQuotaError(`Fichier trop volumineux (${Math.round(sizeBytes / 1024 / 1024)} Mo, plafond ${Math.round(cap / 1024 / 1024)} Mo).`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Sandbox FFmpeg — arguments imposés, protocoles fermés, plafonds
// ────────────────────────────────────────────────────────────────────────────

/**
 * Arguments de sécurité ajoutés À CHAQUE invocation FFmpeg :
 * - -nostdin : jamais d'entrée interactive ;
 * - -protocol_whitelist file,pipe : aucun accès réseau possible depuis un
 *   filtre ou une entrée (protection SSRF définitive — tout est matérialisé
 *   en fichiers locaux dans le tmp du job avant rendu) ;
 * - -max_alloc : borne d'allocation mémoire (protection OOM/zip-bomb) ;
 * - -y : écrasement des sorties du tmp dédié au job uniquement.
 */
export const FFMPEG_SANDBOX_ARGS = ["-nostdin", "-protocol_whitelist", "file,pipe", "-max_alloc", "2147483648"] as const;

// ────────────────────────────────────────────────────────────────────────────
// Résolution des binaires FFmpeg/ffprobe (Task 1-a)
// ────────────────────────────────────────────────────────────────────────────

export type FfmpegBinarySource = "env" | "ffmpeg-static" | "path";
export interface ResolvedBinary {
  path: string;
  source: FfmpegBinarySource;
}

/**
 * Résolution HIÉRARCHIQUE d'un binaire (Task 1-a) :
 *  1. variable d'environnement dédiée (VIDEO_FFMPEG_PATH / VIDEO_FFPROBE_PATH)
 *     — déploiements maître-esclave où FFmpeg vit sur un hôte précis ;
 *  2. paquet npm ffmpeg-static / ffprobe-static (binaires statiques embarqués
 *     — rend le rendu fonctionnel sans installation système) ; import
 *     DYNAMIQUE et gardé : l'absence du paquet ne casse jamais le module ;
 *  3. binaire système sur le PATH (« ffmpeg » / « ffprobe ») — comportement
 *     historique, vérifié par la sonde checkFfmpegAvailable().
 */
async function resolveStaticBinary(
  packageName: "ffmpeg-static" | "ffprobe-static",
  pick: (mod: unknown) => string | null,
): Promise<ResolvedBinary | null> {
  try {
    const mod: unknown = await import(packageName);
    const candidate = pick(mod);
    if (!candidate) return null;
    const { access } = await import("node:fs/promises");
    await access(candidate); // le paquet peut être présent sans binaire téléchargé
    return { path: candidate, source: "ffmpeg-static" };
  } catch {
    return null;
  }
}

function staticFfmpegPath(mod: unknown): string | null {
  // ffmpeg-static : `export default path` (peut être null si l'install
  // script n'a pas tourné) ou `module.exports = path` selon l'interop CJS/ESM.
  const m = mod as { default?: unknown } | string | null;
  const candidate = typeof m === "string" ? m : (m?.default as string | null | undefined);
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function staticFfprobePath(mod: unknown): string | null {
  // ffprobe-static : `module.exports = { path }` (interop : souvent sous default).
  const m = mod as { path?: unknown; default?: { path?: unknown } };
  const candidate = (m?.default?.path ?? m?.path) as string | undefined;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

let ffmpegResolution: Promise<ResolvedBinary> | null = null;
let ffprobeResolution: Promise<ResolvedBinary> | null = null;

/** Résout (et met en cache) le binaire FFmpeg de cet environnement. */
export function resolveFfmpegBinary(): Promise<ResolvedBinary> {
  if (!ffmpegResolution) {
    ffmpegResolution = (async () => {
      const env = process.env.VIDEO_FFMPEG_PATH?.trim();
      if (env) return { path: env, source: "env" } as const;
      const staticBinary = await resolveStaticBinary("ffmpeg-static", staticFfmpegPath);
      if (staticBinary) return staticBinary;
      return { path: "ffmpeg", source: "path" } as const;
    })();
  }
  return ffmpegResolution;
}

/** Résout (et met en cache) le binaire ffprobe de cet environnement. */
export function resolveFfprobeBinary(): Promise<ResolvedBinary> {
  if (!ffprobeResolution) {
    ffprobeResolution = (async () => {
      const env = process.env.VIDEO_FFPROBE_PATH?.trim();
      if (env) return { path: env, source: "env" } as const;
      const staticBinary = await resolveStaticBinary("ffprobe-static", staticFfprobePath);
      if (staticBinary) return staticBinary;
      return { path: "ffprobe", source: "path" } as const;
    })();
  }
  return ffprobeResolution;
}

/** Réinitialise les résolutions en cache (tests / changement d'env à chaud). */
export function resetBinaryResolutionCache(): void {
  ffmpegResolution = null;
  ffprobeResolution = null;
}

/** Timeout par commande FFmpeg : les segments courts sont bornés, les longs rendus passent par des segments. */
export function ffmpegTimeoutSec(outputDurationSec: number): number {
  // Un rendu réel prend ~0,3-1× la durée selon filtres ; on borne largement.
  return Math.min(Math.max(30, Math.ceil(outputDurationSec * 4) + 60), 60 * 60);
}

export const MAX_AUTO_FIX_ROUNDS = 2;

// ────────────────────────────────────────────────────────────────────────────
// Schémas de validation partagés (routes API)
// ────────────────────────────────────────────────────────────────────────────

export const VideoProjectCreateSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(2000).default(""),
  language: z.string().min(2).max(10).default("fr"),
  aspectRatio: z.enum(["16:9", "9:16", "1:1", "4:5", "21:9"]).default("16:9"),
  resolution: z.enum(["480p", "720p", "1080p", "1440p", "4K"]).default("1080p"),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).default(30),
  targetDurationSec: z.number().int().min(VIDEO_LIMITS.minDurationSec).max(VIDEO_LIMITS.maxDurationSec).default(180),
  style: z.string().min(2).max(200).default("documentaire cinématographique"),
  audience: z.string().max(300).optional(),
  platform: z.string().max(60).optional(),
  voicePreference: z
    .object({
      kind: z.enum(["auto", "user_voice", "library"]).default("auto"),
      voiceId: z.string().max(200).optional(),
    })
    .default({ kind: "auto" }),
  musicMood: z.string().max(120).optional(),
});

export const DirectorBriefSchema = z.object({
  brief: z.string().min(10).max(4000),
});

export const RevisionRequestSchema = z.object({
  instruction: z.string().min(3).max(1000),
});

export const TimelinePatchSchema = z.object({
  op: z.enum([
    "move_clip",
    "resize_clip",
    "set_transform",
    "set_effects",
    "set_transition",
    "set_clip_audio",
    "set_motion",
    "set_text",
    "add_text_clip",
    "delete_clip",
    "set_captions",
    "set_music_bed",
  ]),
  clipId: z.string().max(120).optional(),
  trackId: z.string().max(120).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const RenderRequestSchema = z.object({
  derivedTargets: z.array(z.enum(["master_16_9", "youtube_16_9", "shorts_9_16", "tiktok_9_16", "reels_9_16", "square_1_1", "facebook_16_9"])).max(6).default([]),
});

export const VoiceCreateSchema = z.object({
  name: z.string().min(1).max(120),
  language: z.string().min(2).max(10).default("fr"),
  description: z.string().max(500).optional(),
  origin: z.enum(["recording", "elevenlabs", "imported"]),
  sampleR2Key: z.string().max(400).optional(),
  elevenLabsVoiceId: z.string().max(200).optional(),
  durationSec: z.number().min(0).max(3600).optional(),
  isDefault: z.boolean().default(false),
  /** Attestation de droits obligatoire pour toute voix fournie par l'utilisateur. */
  rightsConfirmed: z.boolean().default(false),
});

export const RecordingCreateSchema = z.object({
  projectId: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120),
  durationSec: z.number().min(0.1).max(3600),
  contentType: z.string().min(3).max(120),
  sizeBytes: z.number().int().min(1),
});

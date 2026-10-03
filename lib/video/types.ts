/**
 * GEN3IA VIDEO AGENT — modèle de données complet (Task 79).
 *
 * Philosophie (spécification propriétaire) : une vidéo n'est jamais une
 * génération opaque. Chaque production est un PROJET persistant composé
 * d'éléments contrôlables et rééditables (scénario → storyboard → assets →
 * timeline → montage déterministe → QC → rendu → export), pilotés par un
 * Directeur de production agentique.
 */

// ────────────────────────────────────────────────────────────────────────────
// Projet
// ────────────────────────────────────────────────────────────────────────────

export const VIDEO_PROJECT_STATUSES = [
  "draft",
  "planning",
  "scripted",
  "storyboarded",
  "assets_ready",
  "rendering",
  "completed",
  "failed",
  "archived",
] as const;
export type VideoProjectStatus = (typeof VIDEO_PROJECT_STATUSES)[number];

export const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "1440p", "4K"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

export const VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:5", "21:9"] as const;
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];

export const VIDEO_FPS = [24, 25, 30, 60] as const;
export type VideoFps = (typeof VIDEO_FPS)[number];

/** Formats de diffusion dérivés d'une même production (spec §23). */
export const VIDEO_EXPORT_TARGETS = [
  "master_16_9",
  "youtube_16_9",
  "shorts_9_16",
  "tiktok_9_16",
  "reels_9_16",
  "square_1_1",
  "facebook_16_9",
] as const;
export type VideoExportTarget = (typeof VIDEO_EXPORT_TARGETS)[number];

export interface VideoProject {
  id: string;
  userId: string;
  orgId?: string;
  title: string;
  description: string;
  language: string; // "fr", "en", …
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolution;
  fps: VideoFps;
  targetDurationSec: number;
  style: string; // "documentaire cinématographique", "tutoriel", …
  audience?: string;
  platform?: string; // "youtube", "tiktok", …
  /** Voix préférée : profil utilisateur, voix ElevenLabs, ou "auto". */
  voicePreference: { kind: "auto" | "user_voice" | "library"; voiceId?: string };
  musicMood?: string;
  status: VideoProjectStatus;
  /** Bible visuelle du Consistency Engine (personnages, lieux, palette). */
  visualBible: VisualBible;
  script?: VideoScript;
  storyboard?: StoryboardEntry[];
  timeline?: VideoTimeline;
  /** Journal de production lisible par l'agent et l'utilisateur. */
  productionLog: ProductionLogEntry[];
  versionCounter: number;
  stats: VideoProjectStats;
  createdAt: string;
  updatedAt: string;
}

export interface VideoProjectStats {
  sceneCount: number;
  assetCount: number;
  renderedSeconds: number;
  qcRounds: number;
  billedMinor: number; // total facturé au wallet (unité mineure)
}

export interface ProductionLogEntry {
  at: string;
  actor: "director" | "user" | "system" | "qc";
  message: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Scénario (Script Engine) — structure Hook → Intro → Chapitres → CTA
// ────────────────────────────────────────────────────────────────────────────

export interface VideoScript {
  hook: string;
  introduction: string;
  chapters: ScriptChapter[];
  /** Scènes plates référencées par les chapitres (position startSec calculée). */
  scenes: ScriptScene[];
  conclusion: string;
  callToAction?: string;
  estimatedDurationSec: number;
}

export interface ScriptChapter {
  id: string;
  title: string;
  summary: string;
  sceneIds: string[];
}

export type SceneVisualType = "image" | "video" | "screen_recording";

export interface ScriptScene {
  id: string;
  chapterId: string;
  index: number;
  durationSec: number;
  narration: string;
  onScreenText?: string;
  /** Prompt visuel brut — enrichi par le Consistency Engine à la génération. */
  visualPrompt: string;
  visualType: SceneVisualType;
  cameraMotion: MotionPreset;
  transitionIn: TransitionName;
  transitionOut: TransitionName;
  musicMood?: string;
  soundEffects: SfxName[];
  captions: boolean;
  /** Position dans la timeline (calculée, secondes). */
  startSec: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Consistency Engine — bible visuelle partagée entre scènes
// ────────────────────────────────────────────────────────────────────────────

export interface VisualBible {
  /** Descripteur de style global injecté dans chaque prompt visuel. */
  styleDescriptors: string;
  palette: string;
  era?: string;
  characters: BibleEntity[];
  locations: BibleEntity[];
  /** Instructions négatives récurrentes (artefacts, texte illisible…). */
  negativePrompt?: string;
}

export interface BibleEntity {
  id: string;
  name: string;
  /** Description d'apparence canonique, réutilisée scène après scène. */
  appearancePrompt: string;
  /** Asset image de référence (généré ou importé) pour img2img. */
  referenceAssetId?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Storyboard Engine
// ────────────────────────────────────────────────────────────────────────────

export interface StoryboardEntry {
  sceneId: string;
  timecodeStartSec: number;
  timecodeEndSec: number;
  imageBrief: string;
  animation: MotionPreset;
  voiceBrief: string;
  musicBrief?: string;
  transitionIn: TransitionName;
  /** Asset de vignette (image générée) une fois les assets produits. */
  thumbnailAssetId?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Media Library (assets)
// ────────────────────────────────────────────────────────────────────────────

export const VIDEO_ASSET_KINDS = [
  "image",
  "video",
  "audio_narration",
  "audio_music",
  "audio_sfx",
  "audio_voice_profile",
  "subtitle",
  "document",
] as const;
export type VideoAssetKind = (typeof VIDEO_ASSET_KINDS)[number];

export interface VideoAsset {
  id: string;
  projectId: string;
  userId: string;
  kind: VideoAssetKind;
  role?: string; // "reference:char:ada", "scene:scene_003", "music:main"…
  label: string;
  r2Key: string;
  contentType: string;
  sizeBytes: number;
  /** Métadonnées de médias (durée, dimensions, fps) remplies par ffprobe. */
  media?: MediaProbe;
  origin: "generated" | "uploaded" | "recording" | "library";
  sceneId?: string;
  createdAt: string;
}

export interface MediaProbe {
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  audioCodec?: string;
  videoCodec?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Voix (enregistrement + bibliothèque)
// ────────────────────────────────────────────────────────────────────────────

export type VoiceOrigin = "recording" | "elevenlabs" | "imported";

export interface VoiceProfile {
  id: string;
  userId: string;
  name: string;
  language: string;
  description?: string;
  origin: VoiceOrigin;
  /** Clé R2 de l'échantillon de référence (recording) si clonage autorisé. */
  sampleR2Key?: string;
  /** Identifiant voix ElevenLabs (origine elevenlabs). */
  elevenLabsVoiceId?: string;
  durationSec?: number;
  isDefault: boolean;
  /** Attestation explicite de droits sur la voix (obligatoire, spec §10B). */
  rightsConfirmedAt?: string;
  status: "active" | "expired" | "deleted";
  createdAt: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Timeline Engine — montage multi-pistes (cœur du système)
// ────────────────────────────────────────────────────────────────────────────

export const TRACK_KINDS = ["video", "image", "text", "voice", "music", "sfx"] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];

export interface VideoTimeline {
  version: number;
  durationSec: number;
  resolution: VideoResolution;
  aspectRatio: VideoAspectRatio;
  fps: VideoFps;
  tracks: TimelineTrack[];
  /** Génération automatique des sous-titres activée + style. */
  captions: { enabled: boolean; style: SubtitleStyleName; position: "bottom" | "center" | "top" };
  /** Musique de fond par défaut (assetId + volume nominal). */
  musicBed?: { assetId: string; volume: number; duckTo: number };
  updatedAt: string;
}

export interface TimelineTrack {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  clips: TimelineClip[];
}

export interface TimelineClip {
  id: string;
  assetId?: string;
  /** Texte direct pour la piste text (titrage, écrans). */
  text?: string;
  startSec: number;
  durationSec: number;
  layer: number;
  transform: ClipTransform;
  /** Animation d'image (Motion Engine) — clips image/vidéo. */
  motion?: MotionSpec;
  effects: EffectInstance[];
  transitionIn?: TransitionSpec;
  transitionOut?: TransitionSpec;
  /** Audio (clips voice/music/sfx) : gain relatif + fondus. */
  audio?: ClipAudio;
}

export interface ClipTransform {
  x: number; // -1..1 (fraction de l'écran, 0 = centre)
  y: number;
  scale: number; // 1.0 = pleine taille
  rotationDeg: number;
  opacity: number; // 0..1
  crop?: { top: number; right: number; bottom: number; left: number }; // fractions
}

export interface ClipAudio {
  volume: number; // 0..2
  fadeInSec: number;
  fadeOutSec: number;
}

export interface TransitionSpec {
  name: TransitionName;
  durationSec: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Motion Engine — keyframes transformant une image fixe en séquence vivante
// ────────────────────────────────────────────────────────────────────────────

export const MOTION_PRESETS = [
  "static",
  "slow_zoom",
  "zoom_out",
  "ken_burns",
  "pan_left_right",
  "pan_right_left",
  "tilt_up",
  "tilt_down",
  "parallax",
  "dramatic_push",
] as const;
export type MotionPreset = (typeof MOTION_PRESETS)[number];

export interface MotionSpec {
  preset: MotionPreset;
  /** Keyframes explicites (complétées depuis le preset). */
  keyframes: MotionKeyframe[];
}

export interface MotionKeyframe {
  /** Position normalisée 0..1 sur la durée du clip. */
  at: number;
  scale: number;
  x: number;
  y: number;
  rotationDeg: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Effects Engine + transitions — catalogues fermés (sécurité FFmpeg)
// ────────────────────────────────────────────────────────────────────────────

export const EFFECT_NAMES = [
  "blur",
  "sharpen",
  "brightness",
  "contrast",
  "saturation",
  "vignette",
  "grain",
  "glow",
  "shadow",
  "color_grade_cinematic",
  "color_grade_warm",
  "color_grade_cool",
  "color_grade_bw",
  "cinematic_bars",
  "camera_shake",
  "motion_blur",
] as const;
export type EffectName = (typeof EFFECT_NAMES)[number];

export const EFFECT_INTENSITY = ["subtle", "normal", "strong"] as const;
export type EffectIntensity = (typeof EFFECT_INTENSITY)[number];

export interface EffectInstance {
  name: EffectName;
  intensity: EffectIntensity;
}

export const TRANSITION_NAMES = [
  "cut",
  "fade",
  "dissolve",
  "wipe_left",
  "wipe_right",
  "slide_left",
  "slide_right",
  "zoom",
  "blur",
  "flash",
  "glitch",
  "circle",
  "match",
] as const;
export type TransitionName = (typeof TRANSITION_NAMES)[number];

// ────────────────────────────────────────────────────────────────────────────
// Subtitle Engine
// ────────────────────────────────────────────────────────────────────────────

export const SUBTITLE_STYLES = [
  "documentary",
  "minimal",
  "shorts_bold",
  "cinematic_yellow",
] as const;
export type SubtitleStyleName = (typeof SUBTITLE_STYLES)[number];

export interface SubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
  /** Mots mis en avant (style Shorts/TikTok). */
  emphasis?: string[];
}

export interface SubtitleTrackFile {
  style: SubtitleStyleName;
  position: "bottom" | "center" | "top";
  cues: SubtitleCue[];
}

// ────────────────────────────────────────────────────────────────────────────
// Audio Engine — mixage narration / musique / SFX avec ducking
// ────────────────────────────────────────────────────────────────────────────

export const SFX_NAMES = [
  "whoosh",
  "impact",
  "click",
  "ambient",
  "cinematic_hit",
  "riser",
  "sub_bass",
] as const;
export type SfxName = (typeof SFX_NAMES)[number];

export interface AudioMixPlan {
  narration: AudioItem[];
  music: AudioItem[];
  sfx: AudioItem[];
  /** Enveloppe de ducking : volume musique nominal → duckTo pendant la voix. */
  ducking: { enabled: boolean; nominalVolume: number; duckedVolume: number; attackSec: number; releaseSec: number };
  /** Normalisation cible du mix final (loudness, dB). */
  targetLoudnessDb: number;
}

export interface AudioItem {
  id: string;
  assetId: string;
  startSec: number;
  durationSec: number;
  volume: number;
  fadeInSec: number;
  fadeOutSec: number;
  /** Égalisation simple (filtre passe-haut, passe-bas) appliquée à l'item. */
  eq?: { highpassHz?: number; lowpassHz?: number };
}

// ────────────────────────────────────────────────────────────────────────────
// Render Engine — plan de rendu déterministe exécutable par FFmpeg
// ────────────────────────────────────────────────────────────────────────────

export interface RenderPlan {
  planId: string;
  projectId: string;
  jobId: string;
  resolution: VideoResolution;
  aspectRatio: VideoAspectRatio;
  fps: VideoFps;
  output: { videoCodec: "h264" | "h265" | "vp9"; audioCodec: "aac"; container: "mp4" };
  /** Segments = scènes rendues indépendamment (mémoire bornée, checkpoints). */
  segments: RenderSegment[];
  /** Transitions entre segments consécutifs (xfade ou concat). */
  transitions: Array<{ afterSegmentIndex: number; name: TransitionName; durationSec: number }>;
  audioMix: AudioMixPlan;
  subtitles?: { assR2Key?: string; style: SubtitleStyleName };
  /** Formats dérivés à produire après le master. */
  derivedTargets: VideoExportTarget[];
  /** Clé R2 du master livré (pour les jobs d'export partiels). */
  masterR2Key?: string;
  estimatedSec: number;
}

export interface RenderSegment {
  index: number;
  sceneId: string;
  durationSec: number;
  /** Entrées locales (fichiers tmp téléchargés depuis R2 avant rendu). */
  imageR2Keys: string[];
  videoR2Keys?: string[];
  narrationR2Key?: string;
  motion: MotionSpec;
  effects: EffectInstance[];
  textOverlays: Array<{ text: string; style: SubtitleStyleName; position: "bottom" | "center" | "top" }>;
  transitionIn: TransitionName;
  transitionOut: TransitionName;
}

export const RENDER_JOB_STATUSES = [
  "queued",
  "processing",
  "paused",
  "failed",
  "cancelled",
  "completed",
] as const;
export type RenderJobStatus = (typeof RENDER_JOB_STATUSES)[number];

export const RENDER_STAGES = [
  "plan",
  "download",
  "segments",
  "transitions",
  "audio",
  "subtitles",
  "qc",
  "exports",
  "finalize",
] as const;
export type RenderStage = (typeof RENDER_STAGES)[number];

export interface RenderJob {
  id: string;
  projectId: string;
  userId: string;
  status: RenderJobStatus;
  stage: RenderStage;
  /** 0..1 — progression globale pondérée par étapes. */
  progress: number;
  plan?: RenderPlan;
  /** Checkpoints : reprise au segment N sans tout recommencer (spec §19). */
  checkpoints: {
    downloadedAssetIds: string[];
    completedSegments: number[];
    /** Passe courante de l'assemblage récursif (Long Video Engine). */
    transitionPass: number;
    transitionsDone: boolean;
    audioDone: boolean;
    subtitlesDone: boolean;
    qcDone: boolean;
    exportsDone: string[];
  };
  /** Job complet (production) ou exports seuls (formats dérivés d'un master existant). */
  mode?: "full" | "exports_only";
  qcReport?: QcReport;
  autoFixRounds: number;
  attempts: number;
  errorCode?: string;
  errorMessage?: string;
  output?: { r2Key: string; sizeBytes: number; durationSec: number; width: number; height: number };
  exports: Array<{ target: VideoExportTarget; r2Key: string; sizeBytes: number; status: "pending" | "done" | "failed" }>;
  billedMinor: number;
  tmpDir?: string;
  /** Échéance au-delà de laquelle le tick demande une continuation arrière-plan. */
  deadlineAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Quality Control Agent
// ────────────────────────────────────────────────────────────────────────────

export const QC_ISSUE_KINDS = [
  "audio_clipping",
  "excess_silence",
  "black_frames",
  "missing_asset",
  "scene_too_long",
  "subtitles_desync",
  "duration_mismatch",
  "volume_inconsistent",
  "bad_transition",
  "missing_audio_stream",
] as const;
export type QcIssueKind = (typeof QC_ISSUE_KINDS)[number];

export interface QcIssue {
  kind: QcIssueKind;
  severity: "info" | "warning" | "critical";
  detail: string;
  segmentIndex?: number;
  /** Correctif automatique proposé (appliqué si autoFixRounds < MAX). */
  suggestedFix?: {
    type: "retime_segment" | "rebuild_audio" | "replace_transition" | "reburn_subtitles" | "regenerate_segment";
    payload?: Record<string, unknown>;
  };
}

export interface QcReport {
  passed: boolean;
  checkedAt: string;
  issues: QcIssue[];
  metrics: {
    durationSec?: number;
    maxVolumeDb?: number;
    meanVolumeDb?: number;
    silenceTotalSec?: number;
    blackTotalSec?: number;
    hasAudioStream?: boolean;
    width?: number;
    height?: number;
    fps?: number;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Versions (historique complet, restauration, révisions ciblées)
// ────────────────────────────────────────────────────────────────────────────

export interface ProjectVersion {
  id: string;
  projectId: string;
  versionNumber: number;
  label: string;
  createdBy: "agent" | "user" | "system";
  /** Instantané complet rééditable : scénario + storyboard + timeline. */
  snapshot: {
    script?: VideoScript;
    storyboard?: StoryboardEntry[];
    timeline?: VideoTimeline;
    visualBible: VisualBible;
  };
  note?: string;
  createdAt: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Director Agent — plan de production transformant une demande en projet
// ────────────────────────────────────────────────────────────────────────────

export interface ProductionPlan {
  title: string;
  description: string;
  language: string;
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolution;
  fps: VideoFps;
  targetDurationSec: number;
  style: string;
  audience?: string;
  platform?: string;
  structure: Array<{ chapterTitle: string; sceneCount: number; summary: string }>;
  narrationTone: string;
  visualStyle: string;
  musicMood: string;
  needsVoiceRecording: boolean;
  captions: boolean;
  rationale: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers de calcul temporel partagés
// ────────────────────────────────────────────────────────────────────────────

export function formatTimecode(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const RESOLUTION_DIMENSIONS: Record<VideoResolution, { width: number; height: number }> = {
  "480p": { width: 854, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
  "4K": { width: 3840, height: 2160 },
};

export function dimensionsFor(aspect: VideoAspectRatio, res: VideoResolution): { width: number; height: number } {
  const base = RESOLUTION_DIMENSIONS[res];
  if (aspect === "16:9") return { width: even(base.width), height: even(base.height) };
  const ratioMap: Record<VideoAspectRatio, number> = {
    "16:9": 16 / 9,
    "9:16": 9 / 16,
    "1:1": 1,
    "4:5": 4 / 5,
    "21:9": 21 / 9,
  };
  const target = ratioMap[aspect];
  // La hauteur de référence suit la résolution choisie ; la largeur s'adapte.
  const height = base.height;
  const width = Math.round(height * target);
  return { width: even(width), height: even(height) };
}

function even(n: number): number {
  return n % 2 === 0 ? n : n + 1; // encoders H.264 : dimensions paires
}

import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 15/16 : Video Composition Engine + Render
 * Planner (spec §18).
 *
 * Traduit le projet (scénario + timeline + assets) en un PLAN DE RENDU
 * déterministe, puis en GRAPHES DE FILTRES FFmpeg réels :
 *
 *   Timeline JSON → Render Planner → FFmpeg Filter Graph → segments →
 *   transitions (xfade) → mixage audio (sidechaincompress = ducking réel)
 *   → sous-titres ASS brûlés → master MP4.
 *
 * Toutes les fonctions de construction de graphes sont pures et testées :
 * le même plan produit EXACTEMENT les mêmes commandes (rendu déterministe,
 * reprise au checkpoint sans dérive).
 */

import { randomUUID } from "node:crypto";
import {
  type RenderPlan,
  type RenderSegment,
  type VideoProject,
  type VideoTimeline,
  type VideoAsset,
  type SfxName,
  type MotionSpec,
  dimensionsFor,
} from "@/lib/video/types";
import { buildAudioMixPlan } from "@/lib/video/audio-engine";
import { buildSubtitleTrack, toAssFile } from "@/lib/video/subtitle-service";
import { buildMotion } from "@/lib/video/motion-service";
import { buildEffectFilterChain, xfadeTransitionName } from "@/lib/video/effects-service";

// ────────────────────────────────────────────────────────────────────────────
// Construction du plan de rendu
// ────────────────────────────────────────────────────────────────────────────

export interface BuildPlanInput {
  project: VideoProject;
  timeline: VideoTimeline;
  jobId: string;
  /** Image par scène (asset réel) — les scènes sans image sont ignorées. */
  imageByScene: Map<string, VideoAsset>;
  narrationByScene: Map<string, VideoAsset>;
  sfxAssetByName: Map<SfxName, VideoAsset>;
  musicBedAsset?: VideoAsset;
  derivedTargets: RenderPlan["derivedTargets"];
  /** Clé R2 du fichier ASS de sous-titres (si activés). */
  assR2Key?: string;
}

export function buildRenderPlan(input: BuildPlanInput): RenderPlan {
  const { project, timeline } = input;
  const scenes = project.script?.scenes ?? [];
  const segments: RenderSegment[] = [];
  const transitions: RenderPlan["transitions"] = [];

  scenes.forEach((scene) => {
    const image = input.imageByScene.get(scene.id);
    if (!image) return; // scène sans asset visuel : pas de segment (QC le signalera)
    const narration = input.narrationByScene.get(scene.id);
    segments.push({
      index: segments.length,
      sceneId: scene.id,
      durationSec: scene.durationSec,
      imageR2Keys: [image.r2Key],
      narrationR2Key: narration?.r2Key,
      motion: resolveMotion(project, scene.id, scene.cameraMotion, scene.durationSec),
      effects: sceneEffects(project, scene.id),
      textOverlays: scene.onScreenText
        ? [{ text: scene.onScreenText, style: timeline.captions.style, position: timeline.aspectRatio === "9:16" ? "center" : "bottom" }]
        : [],
      transitionIn: scene.transitionIn,
      transitionOut: scene.transitionOut,
    });
    if (segments.length > 1) {
      transitions.push({
        afterSegmentIndex: segments.length - 2,
        name: scene.transitionIn,
        durationSec: Math.max(0.04, defaultTransition(scene.transitionIn)),
      });
    }
  });

  const audioMix = buildAudioMixPlan({
    project,
    timeline,
    narrationByScene: input.narrationByScene,
    sfxAssetByName: input.sfxAssetByName,
    musicBedAsset: input.musicBedAsset,
  });

  const estimatedSec = segments.reduce((sum, s) => sum + s.durationSec, 0);
  return {
    planId: randomUUID(),
    projectId: project.id,
    jobId: input.jobId,
    resolution: project.resolution,
    aspectRatio: project.aspectRatio,
    fps: project.fps,
    output: { videoCodec: "h264", audioCodec: "aac", container: "mp4" },
    segments,
    transitions,
    audioMix,
    subtitles: timeline.captions.enabled
      ? { assR2Key: input.assR2Key, style: timeline.captions.style }
      : undefined,
    derivedTargets: input.derivedTargets,
    estimatedSec: Math.round(estimatedSec * 100) / 100,
  };
}

function resolveMotion(project: VideoProject, sceneId: string, fallback: MotionSpec["preset"], durationSec: number): MotionSpec {
  const timeline = project.timeline;
  const clip = timeline?.tracks
    .find((t) => t.kind === "image" || t.kind === "video")
    ?.clips.find((c) => c.id === `clip_img_${sceneId}`);
  if (clip?.motion && clip.motion.keyframes.length > 0) return clip.motion;
  return { preset: fallback, keyframes: interpolateFallback(fallback, durationSec) };
}

/** Keyframes du preset demandé (motion-service est pur, import direct). */
function interpolateFallback(preset: MotionSpec["preset"], durationSec: number): MotionSpec["keyframes"] {
  return buildMotion(preset, durationSec).keyframes;
}

function sceneEffects(project: VideoProject, sceneId: string): RenderSegment["effects"] {
  const clip = project.timeline?.tracks
    .find((t) => t.kind === "image" || t.kind === "video")
    ?.clips.find((c) => c.id === `clip_img_${sceneId}`);
  return clip?.effects ?? [];
}

function defaultTransition(name: RenderSegment["transitionIn"]): number {
  switch (name) {
    case "cut": return 0.04; // 1 frame : cut visuel réel
    case "flash": return 0.25;
    case "zoom": case "glitch": return 0.35;
    case "blur": case "circle": return 0.6;
    default: return 0.5;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Graphe de filtres d'un segment (image fixe → séquence animée)
// ────────────────────────────────────────────────────────────────────────────

export interface SegmentFilterContext {
  width: number;
  height: number;
  fps: number;
}

/**
 * Filtres vidéo d'un segment : zoompan (motion keyframes → expression
 * linéaire par frame) + chaîne d'effets + format final.
 * Retourne la liste d'arguments FFmpeg complets du segment.
 */
export function buildSegmentFfmpegArgs(params: {
  segment: RenderSegment;
  ctx: SegmentFilterContext;
  imageFiles: string[];
  outFile: string;
  fontFile?: string;
}): string[] {
  const { segment, ctx } = params;
  const totalFrames = Math.max(1, Math.round(segment.durationSec * ctx.fps));
  const dims = { width: ctx.width, height: ctx.height };

  // Suréchantillon de 30 % pour laisser la caméra se déplacer sans bords vides.
  const overscan = 1.3;
  const srcW = Math.round(dims.width * overscan);
  const srcH = Math.round(dims.height * overscan);

  const first = segment.motion.keyframes[0] ?? { scale: 1, x: 0, y: 0, rotationDeg: 0 };
  const last = segment.motion.keyframes[segment.motion.keyframes.length - 1] ?? first;
  const zStart = first.scale;
  const zEnd = last.scale;
  const xStart = first.x;
  const xEnd = last.x;
  const yStart = first.y;
  const yEnd = last.y;

  // zoompan : z ∈ [1..10] ; x/y en pixels de l'IMAGE source (iw/ih = taille
  // après scale) ; on = numéro de frame de sortie.
  const zExpr = `${zStart.toFixed(4)}+(${(zEnd - zStart).toFixed(4)})*on/${totalFrames}`;
  const panXExpr = `(iw-ow/zoom)/2+${((xEnd - xStart) * dims.width / 2).toFixed(2)}*on/${totalFrames}`;
  const panYExpr = `(ih-oh/zoom)/2+${((yEnd - yStart) * dims.height / 2).toFixed(2)}*on/${totalFrames}`;

  const chain: string[] = [
    `scale=${srcW}:${srcH}:force_original_aspect_ratio=increase`,
    `crop=${srcW}:${srcH}`,
    `zoompan=z='${zExpr}':x='${panXExpr}':y='${panYExpr}':d=${totalFrames}:s=${dims.width}x${dims.height}:fps=${ctx.fps}`,
  ];

  const effectChain = buildEffectFilterChain(segment.effects);
  if (effectChain) chain.push(effectChain);

  // Textes à l'écran (drawtext, fenêtre = début du segment).
  for (const overlay of segment.textOverlays) {
    if (!params.fontFile) break; // dégradation honnête signalée par le worker
    const escaped = escapeDrawtext(overlay.text);
    const yPos = overlay.position === "center" ? `(h/2-th/2)` : overlay.position === "top" ? `h*0.08` : `h*0.82`;
    chain.push(
      `drawtext=fontfile=${params.fontFile}:text='${escaped}':fontsize=${Math.round(dims.height / 18)}:fontcolor=white:borderw=3:bordercolor=black@0.7:x=(w-tw)/2:y=${yPos}:enable='between(t,0.2,${Math.min(segment.durationSec - 0.2, 4).toFixed(2)})'`,
    );
  }

  chain.push("format=yuv420p");

  return [
    "-loop", "1",
    "-framerate", String(ctx.fps),
    "-i", params.imageFiles[0],
    "-vf", chain.join(","),
    "-t", segment.durationSec.toFixed(3),
    "-r", String(ctx.fps),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-an",
    params.outFile,
  ];
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/\n/g, " ");
}

// ────────────────────────────────────────────────────────────────────────────
// Transitions — chaîne xfade avec offsets exacts
// ────────────────────────────────────────────────────────────────────────────

export interface TransitionPlanInput {
  segmentFiles: string[];
  durations: number[];
  transitions: RenderPlan["transitions"];
  outFile: string;
  fps: number;
}

/**
 * Construit la commande d'assemblage : xfade en chaîne pour chaque
 * frontière (cut = crossfade d'une frame = coupe visuelle réelle).
 * offset_k = Σ durées précédentes − Σ transitions précédentes.
 */
export function buildTransitionFfmpegArgs(input: TransitionPlanInput): { args: string[]; expectedDurationSec: number } | null {
  const { segmentFiles, durations, transitions, fps } = input;
  if (segmentFiles.length === 0) return null;
  if (segmentFiles.length === 1) return null; // concat inutile — copie directe

  const transitionAfterIndex = new Map<number, { name: string; durationSec: number }>();
  transitions.forEach((t) => transitionAfterIndex.set(t.afterSegmentIndex, { name: t.name, durationSec: Math.max(0.04, t.durationSec) }));

  const filterParts: string[] = [];
  let prevLabel = "0:v";
  let accumulated = durations[0];

  for (let k = 1; k < segmentFiles.length; k += 1) {
    const boundary = transitionAfterIndex.get(k - 1);
    const tSec = boundary ? Math.min(boundary.durationSec, Math.min(durations[k - 1], durations[k]) / 2) : 0.04;
    const mode = xfadeTransitionName((boundary?.name as RenderSegment["transitionIn"]) ?? "cut") ?? "fade";
    const outLabel = `v${k}`;
    const offset = accumulated - tSec;
    if (offset <= 0) {
      // Segments plus courts que la transition : repli coupe franche.
      filterParts.push(`[${prevLabel}][${k}:v]xfade=transition=fade:duration=0.04:offset=${Math.max(0, accumulated - 0.04).toFixed(3)}[${outLabel}]`);
      accumulated = accumulated + durations[k] - 0.04;
    } else {
      filterParts.push(`[${prevLabel}][${k}:v]xfade=transition=${mode}:duration=${tSec.toFixed(3)}:offset=${offset.toFixed(3)}[${outLabel}]`);
      accumulated = offset + durations[k];
    }
    prevLabel = outLabel;
  }

  return {
    args: [
      ...segmentFiles.flatMap((f) => ["-i", f]),
      "-filter_complex", filterParts.join(";"),
      "-map", `[${prevLabel}]`,
      "-r", String(fps),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-an",
      input.outFile,
    ],
    expectedDurationSec: round2(accumulated),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Mixage audio — ducking RÉEL par sidechaincompress
// ────────────────────────────────────────────────────────────────────────────

export interface AudioMixArgsInput {
  narrationFiles: Array<{ file: string; startSec: number; volume: number; fadeInSec: number; fadeOutSec: number }>;
  musicFile?: string;
  musicVolume: number;
  sfxFiles: Array<{ file: string; startSec: number; volume: number }>;
  ducking: RenderPlan["audioMix"]["ducking"];
  targetLoudnessDb: number;
  durationSec: number;
  outFile: string;
}

/**
 * Construit le mixage final :
 * - narration : adelay + volume + fondus ;
 * - musique : DUCKING AUTOMATIQUE par compresseur à chaîne latérale
 *   (sidechaincompress) — la musique baisse quand la voix parle, avec
 *   attaque/relâche (spec : volume automatiquement réduit) ;
 * - SFX posés à leurs positions ;
 * - normalisation loudnorm vers la cible (−16 LUFS documentaire).
 */
export function buildAudioMixFfmpegArgs(input: AudioMixArgsInput): string[] | null {
  if (input.narrationFiles.length === 0 && !input.musicFile && input.sfxFiles.length === 0) return null;

  const inputs: string[] = [];
  const parts: string[] = [];
  let index = 0;
  const narrationLabels: string[] = [];
  const sfxLabels: string[] = [];
  let musicInputIndex: number | null = null;

  for (const item of input.narrationFiles) {
    inputs.push("-i", item.file);
    const delayMs = Math.round(item.startSec * 1000);
    parts.push(
      `[${index}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${item.volume.toFixed(3)},adelay=${delayMs}|${delayMs},apad[n${index}]`,
    );
    narrationLabels.push(`[n${index}]`);
    index += 1;
  }
  for (const item of input.sfxFiles) {
    inputs.push("-i", item.file);
    const delayMs = Math.round(item.startSec * 1000);
    parts.push(`[${index}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${item.volume.toFixed(3)},adelay=${delayMs}|${delayMs},apad[x${index}]`);
    sfxLabels.push(`[x${index}]`);
    index += 1;
  }
  if (input.musicFile) {
    inputs.push("-i", input.musicFile);
    musicInputIndex = index;
    index += 1;
  }

  const narrationMix = narrationLabels.length > 0
    ? (narrationLabels.length === 1
        ? narrationLabels[0]
        : `${narrationLabels.join("")}amix=inputs=${narrationLabels.length}:duration=longest:normalize=0[narrmix]`)
    : null;
  if (narrationMix && narrationLabels.length > 1) parts.push(narrationMix);
  const narrLabel = narrationLabels.length > 0 ? (narrationLabels.length === 1 ? narrationLabels[0] : "[narrmix]") : null;

  let finalInputs: string[] = [];

  if (input.musicFile && musicInputIndex !== null && narrLabel && input.ducking.enabled) {
    // Ducking RÉEL : compresseur à chaîne latérale piloté par la narration.
    const ratio = Math.max(2, input.ducking.nominalVolume / Math.max(input.ducking.duckedVolume, 0.05));
    parts.push(
      `[${musicInputIndex}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${input.musicVolume.toFixed(3)},atrim=0:${input.durationSec.toFixed(3)},asetpts=PTS-STARTPTS[mus]`,
    );
    parts.push(
      `[mus]${narrLabel}sidechaincompress=threshold=0.02:ratio=${ratio.toFixed(1)}:attack=${Math.round(input.ducking.attackSec * 1000)}:release=${Math.round(input.ducking.releaseSec * 1000)}:makeup=1[musduck]`,
    );
    finalInputs = ["[musduck]", ...sfxLabels];
  } else if (input.musicFile && musicInputIndex !== null) {
    parts.push(
      `[${musicInputIndex}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${input.musicVolume.toFixed(3)},atrim=0:${input.durationSec.toFixed(3)},asetpts=PTS-STARTPTS[musduck]`,
    );
    finalInputs = ["[musduck]", ...sfxLabels];
  } else {
    finalInputs = [...narrationLabels, ...sfxLabels];
  }

  if (finalInputs.length === 0) return null;

  // Somme finale + normalisation loudness vers la cible (ex : -16 LUFS).
  const mixed = finalInputs.length === 1
    ? `${finalInputs[0]}atrim=0:${input.durationSec.toFixed(3)},asetpts=PTS-STARTPTS[mix0]`
    : `${finalInputs.join("")}amix=inputs=${finalInputs.length}:duration=longest:normalize=0,atrim=0:${input.durationSec.toFixed(3)},asetpts=PTS-STARTPTS[mix0]`;
  parts.push(mixed);
  parts.push(`[mix0]loudnorm=I=${input.targetLoudnessDb}:TP=-1.5:LRA=11,alimiter=limit=0.95[finalmix]`);

  return [
    ...inputs,
    "-filter_complex", parts.join(";"),
    "-map", "[finalmix]",
    "-t", input.durationSec.toFixed(3),
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
    input.outFile,
  ];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ────────────────────────────────────────────────────────────────────────────
// Exports dérivés — recadrage multi-formats (spec §23)
// ────────────────────────────────────────────────────────────────────────────

export const EXPORT_GEOMETRY: Record<string, { width: number; height: number; reframe: boolean }> = {
  master_16_9: { width: 1920, height: 1080, reframe: false },
  youtube_16_9: { width: 1920, height: 1080, reframe: false },
  facebook_16_9: { width: 1280, height: 720, reframe: false },
  shorts_9_16: { width: 1080, height: 1920, reframe: true },
  tiktok_9_16: { width: 1080, height: 1920, reframe: true },
  reels_9_16: { width: 1080, height: 1920, reframe: true },
  square_1_1: { width: 1080, height: 1080, reframe: true },
};

/** Commande de recadrage d'un format dérivé (scale cover + crop centré). */
export function buildExportFfmpegArgs(params: { masterFile: string; target: string; outFile: string; assFile?: string; fontDir?: string }): string[] {
  const geometry = EXPORT_GEOMETRY[targetKey(params.target)] ?? EXPORT_GEOMETRY.master_16_9;
  const filters: string[] = [
    `scale=${geometry.width}:${geometry.height}:force_original_aspect_ratio=increase`,
    `crop=${geometry.width}:${geometry.height}`,
  ];
  if (params.assFile) {
    filters.push(`subtitles=${params.assFile}`);
  }
  return [
    "-i", params.masterFile,
    "-vf", filters.join(","),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    params.outFile,
  ];
}

function targetKey(target: string): string {
  return target;
}

/** Dimensions du rendu selon projet. */
export function renderDimensions(project: VideoProject): { width: number; height: number } {
  return dimensionsFor(project.aspectRatio, project.resolution);
}

/** Génère le fichier ASS pour le rendu (version master ou dérivée). */
export function buildAssForRender(project: VideoProject, timeline: VideoTimeline, width: number, height: number): string | null {
  if (!project.script || !timeline.captions.enabled) return null;
  const track = buildSubtitleTrack(project.script.scenes, timeline.captions.style, timeline.captions.position);
  if (track.cues.length === 0) return null;
  return toAssFile(track, width, height, timeline.fps);
}

/** Variante Shorts : sous-titres centrés, gras (style TikTok/Reels). */
export function buildShortsAss(project: VideoProject, width: number, height: number): string | null {
  if (!project.script) return null;
  const track = buildSubtitleTrack(project.script.scenes, "shorts_bold", "center");
  if (track.cues.length === 0) return null;
  return toAssFile(track, width, height, project.fps);
}

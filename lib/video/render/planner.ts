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
  type MotionKeyframe,
  dimensionsFor,
} from "@/lib/video/types";
import { buildAudioMixPlan } from "@/lib/video/audio-engine";
import { buildSubtitleTrack, toAssFile } from "@/lib/video/subtitle-service";
import { buildMotion } from "@/lib/video/motion-service";
import { buildEffectFilterChain, xfadeTransitionName } from "@/lib/video/effects-service";
import {
  buildTransformFilters,
  extractSegmentTransform,
  type SegmentTransform,
  type TransformableRenderSegment,
} from "@/lib/video/render/segment-transform";

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
  /**
   * Lits musicaux PAR AMBIANCE (Task 106-b — musique par scène) : map
   * mood → asset, préparée en amont par ensureMusicBedsForScenes().
   * Absent → lit musical unique historique (comportement inchangé).
   */
  musicBedsByMood?: Map<string, VideoAsset>;
  derivedTargets: RenderPlan["derivedTargets"];
  /** Clé R2 du fichier ASS de sous-titres (si activés). */
  assR2Key?: string;
}

export function buildRenderPlan(input: BuildPlanInput): RenderPlan {
  const { project, timeline } = input;
  const scenes = project.script?.scenes ?? [];
  // Task 106-b — segments extensibles : le transform du clip image de la
  // timeline (x/y/scale/opacity) accompagne le segment quand il est non
  // neutre (aucun champ ajouté sinon — sérialisation inchangée).
  const segments: TransformableRenderSegment[] = [];
  const transitions: RenderPlan["transitions"] = [];

  scenes.forEach((scene) => {
    const image = input.imageByScene.get(scene.id);
    if (!image) return; // scène sans asset visuel : pas de segment (QC le signalera)
    const narration = input.narrationByScene.get(scene.id);
    const transform: SegmentTransform | undefined = extractSegmentTransform(timeline, scene.id);
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
      ...(transform ? { transform } : {}),
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
    musicBedsByMood: input.musicBedsByMood,
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
// Expressions zoompan / rotate — helpers PURES exportées (testables)
// Task 106-b : interpolation de TOUS les keyframes (et plus seulement
// first/last) + rotation réelle. Rendu déterministe préservé.
// ────────────────────────────────────────────────────────────────────────────

export interface ZoompanExpression {
  z: string;
  x: string;
  y: string;
}

interface FramePoint {
  frame: number;
  value: number;
}

/** Keyframe neutre (image pleine, centrée, sans rotation). */
const IDENTITY_KEYFRAME: MotionKeyframe = { at: 0, scale: 1, x: 0, y: 0, rotationDeg: 0 };

/**
 * Normalise des keyframes pour génération d'expression : valeurs non
 * finies écartées, `at` borné à [0,1], tri par `at` croissant.
 */
export function normalizeKeyframes(keyframes: MotionKeyframe[]): MotionKeyframe[] {
  const finite = keyframes.filter(
    (kf) =>
      Number.isFinite(kf?.at) &&
      Number.isFinite(kf?.scale) &&
      Number.isFinite(kf?.x) &&
      Number.isFinite(kf?.y),
  );
  return [...finite]
    .map((kf) => ({ ...kf, at: Math.min(1, Math.max(0, kf.at)) }))
    .sort((a, b) => a.at - b.at);
}

/** Rotation d'une keyframe en radians (défense en profondeur : valeur non finie → 0). */
function rotationRad(kf: MotionKeyframe): number {
  const deg = typeof kf.rotationDeg === "number" && Number.isFinite(kf.rotationDeg) ? kf.rotationDeg : 0;
  return (deg * Math.PI) / 180;
}

/**
 * Points (frame, valeur) d'un champ des keyframes : position = round(at ×
 * frames) bornée à [0, frames] ; deux keyframes tombant sur la même frame →
 * la plus tardive gagne (sémantique « dernier état »).
 */
function keyframePoints(kfs: MotionKeyframe[], frames: number, pick: (kf: MotionKeyframe) => number): FramePoint[] {
  const byFrame = new Map<number, number>();
  for (const kf of kfs) {
    const frame = Math.min(frames, Math.max(0, Math.round(kf.at * frames)));
    byFrame.set(frame, pick(kf));
  }
  return [...byFrame.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([frame, value]) => ({ frame, value }));
}

/**
 * Expression FFmpeg linéaire PAR MORCEAUX : chaque segment [F_k, F_{k+1}]
 * est une interpolation linéaire (bornée par clip() — palier avant le 1er
 * point et après le dernier), les segments sont sélectionnés par des if()
 * imbriqués évalués par frame. `varName` : "on" (zoompan) ou "n" (rotate).
 */
export function buildPiecewiseLinearExpr(points: FramePoint[], varName: "on" | "n", decimals: number): string {
  if (points.length === 0) return "0";
  if (points.length === 1) return points[0].value.toFixed(decimals);
  // Toutes les valeurs identiques → expression constante (ex : rotation fixe).
  if (points.every((p) => Math.abs(p.value - points[0].value) < 1e-9)) {
    return points[0].value.toFixed(decimals);
  }
  const segments: string[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const span = Math.max(1, b.frame - a.frame);
    const numerator = a.frame === 0 ? `clip(${varName},${a.frame},${b.frame})` : `(clip(${varName},${a.frame},${b.frame})-${a.frame})`;
    segments.push(`${a.value.toFixed(decimals)}+(${(b.value - a.value).toFixed(decimals)})*${numerator}/${span}`);
  }
  // if() imbriqués : le dernier segment sert de branche finale (clip →
  // valeur constante maintenue jusqu'à la dernière frame).
  let expr = segments[segments.length - 1];
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    expr = `if(lte(${varName},${points[i + 1].frame}),${segments[i]},${expr})`;
  }
  return expr;
}

/**
 * Expressions zoompan (z/x/y) interpolant TOUS les keyframes.
 *
 * - 2 keyframes couvrant toute la durée (cas historique : presets 2 points,
 *   keyframes posées par l'UI) : formules linéaires compactes INCHANGÉES
 *   (zéro régression octet par octet sur les rendus existants).
 * - 3+ keyframes (presets slow_zoom/parallax/dramatic_push, scénarios
 *   avancés) : interpolation linéaire par morceaux — chaque keyframe
 *   intermédiaire est réellement atteinte à sa frame.
 *
 * x/y : offset RELATIF à la première keyframe (la caméra part du centre,
 * convention existante), en pixels de l'image source ; le terme de
 * centrage (iw-ow/zoom)/2 reste dynamique (suit le zoom courant).
 */
export function buildZoompanExpression(
  keyframes: MotionKeyframe[],
  frames: number,
  dims: { width: number; height: number },
): ZoompanExpression {
  const normalized = normalizeKeyframes(keyframes);
  const kfs = normalized.length > 0 ? normalized : [IDENTITY_KEYFRAME, { ...IDENTITY_KEYFRAME, at: 1 }];
  const safeFrames = Math.max(1, Math.round(frames));
  const first = kfs[0];
  const last = kfs[kfs.length - 1];

  const legacyTwoPoint = kfs.length === 2 && kfs[0].at <= 0 && kfs[kfs.length - 1].at >= 1;
  if (legacyTwoPoint) {
    const zExpr = `${first.scale.toFixed(4)}+(${(last.scale - first.scale).toFixed(4)})*on/${safeFrames}`;
    const panXExpr = `(iw-ow/zoom)/2+${(((last.x - first.x) * dims.width) / 2).toFixed(2)}*on/${safeFrames}`;
    const panYExpr = `(ih-oh/zoom)/2+${(((last.y - first.y) * dims.height) / 2).toFixed(2)}*on/${safeFrames}`;
    return { z: zExpr, x: panXExpr, y: panYExpr };
  }

  const zPoints = keyframePoints(kfs, safeFrames, (kf) => kf.scale);
  const xPoints = keyframePoints(kfs, safeFrames, (kf) => ((kf.x - first.x) * dims.width) / 2);
  const yPoints = keyframePoints(kfs, safeFrames, (kf) => ((kf.y - first.y) * dims.height) / 2);
  return {
    z: buildPiecewiseLinearExpr(zPoints, "on", 4),
    x: `(iw-ow/zoom)/2+${buildPiecewiseLinearExpr(xPoints, "on", 2)}`,
    y: `(ih-oh/zoom)/2+${buildPiecewiseLinearExpr(yPoints, "on", 2)}`,
  };
}

/**
 * Expression d'ANGLE (radians) du filtre rotate, interpolant tous les
 * keyframes — NULL quand aucune rotation (aucun filtre ajouté : zéro
 * régression). Le filtre rotate évalue `n` (numéro de la frame d'entrée,
 * 0-based) ; l'angle est exprimé en radians (rotationDeg × π/180).
 */
export function buildRotateExpression(keyframes: MotionKeyframe[], frames: number): string | null {
  const kfs = normalizeKeyframes(keyframes);
  if (kfs.length === 0) return null;
  const hasRotation = kfs.some((kf) => Math.abs(rotationRad(kf)) > 1e-9);
  if (!hasRotation) return null;
  const safeFrames = Math.max(1, Math.round(frames));
  const points = keyframePoints(kfs, safeFrames, rotationRad);
  return buildPiecewiseLinearExpr(points, "n", 6);
}

/**
 * Facteur de suréchantillon supplémentaire pour la ROTATION : après
 * rotation d'angle θ dans un cadre fixe, le contenu ne couvre plus les
 * coins. On pré-agrandit l'image de cos|θ| + (max/min des dimensions)·sin|θ|
 * (formule d'inscription du rectangle tourné), plafonnée à 1.5 — le crop
 * final recoupe les coins vides avant le zoompan. Factor = 1 sans rotation.
 */
export function rotationOverscanFactor(rotationDeg: number, width: number, height: number): number {
  const theta = Math.min(Math.abs(rotationDeg), 180) * (Math.PI / 180);
  const cos = Math.abs(Math.cos(theta));
  const sin = Math.abs(Math.sin(theta));
  const ratio = Math.max(width, height) / Math.max(1, Math.min(width, height));
  return Math.min(1.5, Math.max(1, cos + ratio * sin));
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
 * Filtres vidéo d'un segment : zoompan (TOUTES les motion keyframes →
 * expression linéaire par frame), rotation réelle (filtre rotate quand les
 * keyframes en portent), transform du clip image (x/y/scale/opacity de la
 * timeline, niveau canvas) + chaîne d'effets + format final.
 * Retourne la liste d'arguments FFmpeg complets du segment.
 */
export function buildSegmentFfmpegArgs(params: {
  segment: TransformableRenderSegment;
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

  // Task 106-b — expressions interpolant TOUTES les keyframes (2 points →
  // formules historiques compactes ; 3+ → linéaire par morceaux).
  const kfs = normalizeKeyframes(segment.motion.keyframes);
  const zoompanExpr = buildZoompanExpression(segment.motion.keyframes, totalFrames, dims);
  const rotateExpr = buildRotateExpression(segment.motion.keyframes, totalFrames);

  const chain: string[] = [];
  if (rotateExpr) {
    // Rotation (Task 106-b) : pré-agrandissement couvrant l'angle maximal
    // (pattern overscan étendu), rotation AVANT le crop final et le zoompan
    // (les coins vides sont recoupés, la fenêtre caméra reste pleine).
    const maxRotDeg = kfs.reduce((max, kf) => Math.max(max, Math.abs(typeof kf.rotationDeg === "number" && Number.isFinite(kf.rotationDeg) ? kf.rotationDeg : 0)), 0);
    const factor = rotationOverscanFactor(maxRotDeg, dims.width, dims.height);
    chain.push(`scale=${Math.round(srcW * factor)}:${Math.round(srcH * factor)}:force_original_aspect_ratio=increase`);
    chain.push(`rotate=angle='${rotateExpr}':ow=iw:oh=ih`);
    chain.push(`crop=${srcW}:${srcH}`);
  } else {
    chain.push(`scale=${srcW}:${srcH}:force_original_aspect_ratio=increase`);
    chain.push(`crop=${srcW}:${srcH}`);
  }

  // zoompan : z ∈ [1..10] ; x/y en pixels de l'IMAGE source (iw/ih = taille
  // après scale) ; on = numéro de frame de sortie.
  chain.push(`zoompan=z='${zoompanExpr.z}':x='${zoompanExpr.x}':y='${zoompanExpr.y}':d=${totalFrames}:s=${dims.width}x${dims.height}:fps=${ctx.fps}`);

  // Task 106-b — transform du clip image (x/y/scale/opacity de la timeline),
  // appliqué au niveau canvas APRÈS la caméra et AVANT effets/textes.
  // Absent ou neutre → aucun filtre ajouté (comportement historique).
  chain.push(...buildTransformFilters(segment.transform, dims));

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
// Mixage audio — ducking RÉEL par sidechaincompress + lits multiples
// ────────────────────────────────────────────────────────────────────────────

export interface AudioMixArgsInput {
  narrationFiles: Array<{ file: string; startSec: number; volume: number; fadeInSec: number; fadeOutSec: number }>;
  /** Lit musical UNIQUE (chemin historique — ignoré si musicFiles est fourni). */
  musicFile?: string;
  musicVolume: number;
  /**
   * Lits musicaux MULTIPLES (Task 106-b — musique par scène) : chaque lit
   * est posé à sa fenêtre de groupe avec fondu entrant/sortant (crossfade
   * ~1 s aux jonctions entre moods). Prioritaire sur musicFile.
   */
  musicFiles?: MusicTrackInput[];
  sfxFiles: Array<{ file: string; startSec: number; volume: number }>;
  ducking: RenderPlan["audioMix"]["ducking"];
  targetLoudnessDb: number;
  durationSec: number;
  outFile: string;
}

/** Un lit musical matérialisé pour le mixage (musique par scène, Task 106-b). */
export interface MusicTrackInput {
  file: string;
  startSec: number;
  durationSec: number;
  volume: number;
  fadeInSec: number;
  fadeOutSec: number;
}

/**
 * Construit le mixage final :
 * - narration : adelay + volume + fondus ;
 * - musique : DUCKING AUTOMATIQUE par compresseur à chaîne latérale
 *   (sidechaincompress) — la musique baisse quand la voix parle, avec
 *   attaque/relâche (spec : volume automatiquement réduit) ;
 * - musique PAR SCÈNE (Task 106-b) : plusieurs lits, chacun atrim'é à sa
 *   fenêtre, fondu entrant/sortant, adelay à la position du groupe ;
 * - SFX posés à leurs positions ;
 * - normalisation loudnorm vers la cible (−16 LUFS documentaire).
 *
 * FIX 106-b : la narration était ABSENTE du mix final dès qu'un lit
 * musical existait (son label était consommé par le sidechaincompress et
 * le mix final ne comptait que [musique]+[sfx]). asplit duplique désormais
 * la narration : une branche est mixée, l'autre pilote le compresseur.
 */
export function buildAudioMixFfmpegArgs(input: AudioMixArgsInput): string[] | null {
  const musicFiles = input.musicFiles ?? [];
  if (input.narrationFiles.length === 0 && !input.musicFile && musicFiles.length === 0 && input.sfxFiles.length === 0) return null;

  const inputs: string[] = [];
  const parts: string[] = [];
  let index = 0;
  const narrationLabels: string[] = [];
  const sfxLabels: string[] = [];
  const musicLabels: string[] = [];

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

  // Lits multiples (musique par scène) : atrim à la fenêtre du groupe,
  // fondus entrant/sortant (crossfade aux jonctions), pose adelay.
  for (const item of musicFiles) {
    inputs.push("-i", item.file);
    const dur = Math.max(0.1, Number.isFinite(item.durationSec) ? item.durationSec : 0.1);
    const fadeIn = Math.max(0, Number.isFinite(item.fadeInSec) ? item.fadeInSec : 0);
    const fadeOut = Math.max(0, Number.isFinite(item.fadeOutSec) ? item.fadeOutSec : 0);
    const fadeOutStart = Math.max(0, dur - fadeOut);
    const delayMs = Math.round(item.startSec * 1000);
    parts.push(
      `[${index}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${item.volume.toFixed(3)},atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=${fadeIn.toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(3)},adelay=${delayMs}|${delayMs},apad[m${index}]`,
    );
    musicLabels.push(`[m${index}]`);
    index += 1;
  }

  // Lit unique historique (chaîne inchangée → zéro régression).
  if (musicFiles.length === 0 && input.musicFile) {
    inputs.push("-i", input.musicFile);
    parts.push(
      `[${index}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${input.musicVolume.toFixed(3)},atrim=0:${input.durationSec.toFixed(3)},asetpts=PTS-STARTPTS[mus]`,
    );
    musicLabels.push("[mus]");
    index += 1;
  }

  // Somme narration (amix si plusieurs items — inchangé).
  const narrationMix = narrationLabels.length > 0
    ? (narrationLabels.length === 1
        ? narrationLabels[0]
        : `${narrationLabels.join("")}amix=inputs=${narrationLabels.length}:duration=longest:normalize=0[narrmix]`)
    : null;
  if (narrationMix && narrationLabels.length > 1) parts.push(narrationMix);
  const narrLabel = narrationLabels.length > 0 ? (narrationLabels.length === 1 ? narrationLabels[0] : "[narrmix]") : null;

  // Somme des lits musicaux (amix si plusieurs — Task 106-b).
  let musicMixed: string | null = null;
  if (musicLabels.length === 1) {
    musicMixed = musicLabels[0];
  } else if (musicLabels.length > 1) {
    parts.push(`${musicLabels.join("")}amix=inputs=${musicLabels.length}:duration=longest:normalize=0[musmix]`);
    musicMixed = "[musmix]";
  }

  let musicFinal: string | null = musicMixed;
  let narrFinal: string | null = narrLabel;

  if (musicMixed && narrLabel && input.ducking.enabled) {
    // Ducking RÉEL : compresseur à chaîne latérale piloté par la narration.
    // FIX 106-b : asplit de la narration — [narrmain] reste mixée (elle
    // était perdue avant), [narrsc] pilote le sidechain.
    const ratio = Math.max(2, input.ducking.nominalVolume / Math.max(input.ducking.duckedVolume, 0.05));
    parts.push(`${narrLabel}asplit=2[narrmain][narrsc]`);
    parts.push(
      `${musicMixed}[narrsc]sidechaincompress=threshold=0.02:ratio=${ratio.toFixed(1)}:attack=${Math.round(input.ducking.attackSec * 1000)}:release=${Math.round(input.ducking.releaseSec * 1000)}:makeup=1[musduck]`,
    );
    musicFinal = "[musduck]";
    narrFinal = "[narrmain]";
  }

  const finalInputs: string[] = [];
  if (musicFinal) finalInputs.push(musicFinal);
  if (narrFinal) finalInputs.push(narrFinal);
  finalInputs.push(...sfxLabels);

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

/**
 * Génère le fichier ASS pour le rendu (version master ou dérivée).
 * Task 106-b — `realNarrationDurationByScene` (durations ffprobe réelles
 * des narrations, optionnel) : les cues sont ancrées sur la durée réelle
 * de la voix au lieu de la fin théorique de scène. Absent → inchangé.
 */
export function buildAssForRender(
  project: VideoProject,
  timeline: VideoTimeline,
  width: number,
  height: number,
  realNarrationDurationByScene?: Map<string, number>,
): string | null {
  if (!project.script || !timeline.captions.enabled) return null;
  const track = buildSubtitleTrack(project.script.scenes, timeline.captions.style, timeline.captions.position, realNarrationDurationByScene);
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

import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 12 : Timeline Engine (spec §12).
 *
 * LE CŒUR DU SYSTÈME : une timeline multi-pistes réelle
 * (VIDEO/IMAGE/TEXT/VOICE/MUSIC/SFX) que l'agent construit depuis le
 * scénario puis que l'utilisateur ET l'agent manipulent : start, duration,
 * layer, position, scale, rotation, opacity, crop, volume, fade,
 * keyframes, transitions, effets.
 *
 * Construction initiale DÉTERMINISTE depuis le scénario (1 clip image par
 * scène avec son motion, clips SFX, texte à l'écran) — l'édition passe
 * par des opérations typées et VALIDÉES (aucune injection arbitraire).
 */

import { randomUUID } from "node:crypto";
import {
  type TimelineClip,
  type TimelineTrack,
  type VideoProject,
  type VideoTimeline,
  type TrackKind,
  type MotionPreset,
  type TransitionName,
  type ClipTransform,
  type EffectInstance,
  type EffectIntensity,
  type SubtitleStyleName,
} from "@/lib/video/types";
import { buildMotion } from "@/lib/video/motion-service";
import { defaultTransitionDurationSec } from "@/lib/video/effects-service";

const NEUTRAL_TRANSFORM: ClipTransform = {
  x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1,
};

export interface BuildTimelineOptions {
  shortForm: boolean;
  captionsStyle: SubtitleStyleName;
}

/**
 * Construit la timeline initiale depuis le scénario : chaque scène devient
 * un clip image animé (Motion Engine), ses SFX sont posés, ses textes à
 * l'écran créés sur la piste TEXT, la musique de fond s'étend sur tout le
 * montage. Les narrations sont synchronisées ensuite (syncVoiceTrack).
 */
export function buildTimelineFromScript(project: VideoProject, options: BuildTimelineOptions): VideoTimeline {
  const scenes = project.script?.scenes ?? [];
  const imageTrack: TimelineTrack = {
    id: `track_image_${randomUUID().slice(0, 8)}`,
    kind: "image",
    name: "Images animées",
    muted: false,
    clips: scenes.map((scene) => toImageClip(scene.id, scene.startSec, scene.durationSec, scene.cameraMotion, scene.transitionIn, scene.transitionOut)),
  };
  const textTrack: TimelineTrack = {
    id: `track_text_${randomUUID().slice(0, 8)}`,
    kind: "text",
    name: "Textes",
    muted: false,
    clips: scenes
      .filter((s) => s.onScreenText)
      .map((s) => toTextClip(s.onScreenText!, s.startSec + 0.3, Math.min(3, s.durationSec - 0.4))),
  };
  const sfxTrack: TimelineTrack = {
    id: `track_sfx_${randomUUID().slice(0, 8)}`,
    kind: "sfx",
    name: "Effets sonores",
    muted: false,
    clips: scenes.flatMap((s) =>
      s.soundEffects.map((_, i) =>
        toSfxClip(Math.max(0, s.startSec - 0.15 + i * 0.1)),
      ),
    ),
  };
  const musicTrack: TimelineTrack = {
    id: `track_music_${randomUUID().slice(0, 8)}`,
    kind: "music",
    name: "Musique",
    muted: false,
    clips: [],
  };
  const voiceTrack: TimelineTrack = {
    id: `track_voice_${randomUUID().slice(0, 8)}`,
    kind: "voice",
    name: "Voix / narration",
    muted: false,
    clips: [],
  };

  const durationSec = scenes.reduce((sum, s) => sum + s.durationSec, 0);
  const timeline: VideoTimeline = {
    version: 1,
    durationSec: round2(durationSec),
    resolution: project.resolution,
    aspectRatio: project.aspectRatio,
    fps: project.fps,
    tracks: [imageTrack, textTrack, voiceTrack, musicTrack, sfxTrack],
    captions: {
      enabled: project.script?.scenes.every((s) => s.captions) ?? options.shortForm,
      style: options.shortForm ? "shorts_bold" : options.captionsStyle,
      position: options.shortForm ? "center" : "bottom",
    },
    musicBed: undefined,
    updatedAt: new Date().toISOString(),
  };
  return timeline;
}

function toImageClip(sceneId: string, startSec: number, durationSec: number, motion: MotionPreset, transitionIn: TransitionName, transitionOut: TransitionName): TimelineClip {
  return {
    id: `clip_img_${sceneId}`,
    startSec: round2(startSec),
    durationSec: round2(durationSec),
    layer: 0,
    transform: { ...NEUTRAL_TRANSFORM },
    motion: buildMotion(motion, durationSec),
    effects: [],
    transitionIn: transitionIn === "cut" ? undefined : { name: transitionIn, durationSec: defaultTransitionDurationSec(transitionIn) },
    transitionOut: transitionOut === "cut" ? undefined : { name: transitionOut, durationSec: defaultTransitionDurationSec(transitionOut) },
  };
}

function toTextClip(text: string, startSec: number, durationSec: number): TimelineClip {
  return {
    id: `clip_txt_${randomUUID().slice(0, 8)}`,
    text,
    startSec: round2(startSec),
    durationSec: round2(Math.max(0.5, durationSec)),
    layer: 5,
    transform: { ...NEUTRAL_TRANSFORM, y: -0.35 },
    effects: [{ name: "shadow", intensity: "subtle" }],
  };
}

function toSfxClip(startSec: number): TimelineClip {
  return {
    id: `clip_sfx_${randomUUID().slice(0, 8)}`,
    startSec: round2(startSec),
    durationSec: 1,
    layer: 0,
    transform: { ...NEUTRAL_TRANSFORM },
    effects: [],
    audio: { volume: 0.8, fadeInSec: 0.01, fadeOutSec: 0.2 },
  };
}

/** Synchronise les clips VOIX depuis les narrations réellement disponibles. */
export function syncVoiceTrack(timeline: VideoTimeline, narrationByScene: Array<{ sceneId: string; assetId: string; startSec: number; durationSec: number }>): VideoTimeline {
  const voiceTrack = timeline.tracks.find((t) => t.kind === "voice");
  if (!voiceTrack) return timeline;
  voiceTrack.clips = narrationByScene.map((n) => ({
    id: `clip_voice_${n.sceneId}`,
    assetId: n.assetId,
    startSec: round2(n.startSec),
    durationSec: round2(n.durationSec),
    layer: 0,
    transform: { ...NEUTRAL_TRANSFORM },
    effects: [],
    audio: { volume: 1, fadeInSec: 0.05, fadeOutSec: 0.1 },
  }));
  return { ...timeline, updatedAt: new Date().toISOString() };
}

// ────────────────────────────────────────────────────────────────────────────
// Validation + opérations d'édition typées
// ────────────────────────────────────────────────────────────────────────────

export function findClip(timeline: VideoTimeline, clipId: string): { track: TimelineTrack; clip: TimelineClip } | null {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

export function recomputeDuration(timeline: VideoTimeline): number {
  const end = Math.max(
    0,
    ...timeline.tracks.flatMap((t) => t.clips.map((c) => c.startSec + c.durationSec)),
  );
  timeline.durationSec = round2(end);
  return timeline.durationSec;
}

/** Validation complète — lève avec un message exploitable si incohérent. */
export function validateTimeline(timeline: VideoTimeline): void {
  if (timeline.tracks.length === 0) throw new Error("Timeline sans pistes.");
  for (const track of timeline.tracks) {
    const sorted = [...track.clips].sort((a, b) => a.startSec - b.startSec);
    for (let i = 0; i < sorted.length; i += 1) {
      const clip = sorted[i];
      if (clip.durationSec <= 0) throw new Error(`Clip ${clip.id} : durée nulle ou négative.`);
      if (clip.startSec < 0) throw new Error(`Clip ${clip.id} : position négative.`);
      if (!track.muted && (track.kind === "image" || track.kind === "video")) {
        const next = sorted[i + 1];
        if (next && next.startSec < clip.startSec + clip.durationSec - 0.001) {
          throw new Error(`Piste ${track.name} : chevauchement entre ${clip.id} et ${next.id}.`);
        }
      }
      const t = clip.transform;
      if (t.scale <= 0 || t.scale > 4) throw new Error(`Clip ${clip.id} : échelle hors bornes (0..4).`);
      if (t.opacity < 0 || t.opacity > 1) throw new Error(`Clip ${clip.id} : opacité hors bornes (0..1).`);
      if (clip.audio && (clip.audio.volume < 0 || clip.audio.volume > 2)) {
        throw new Error(`Clip ${clip.id} : volume hors bornes (0..2).`);
      }
    }
  }
  if (timeline.durationSec <= 0) throw new Error("Timeline vide.");
}

export type TimelinePatchOp =
  | "move_clip"
  | "resize_clip"
  | "set_transform"
  | "set_effects"
  | "set_transition"
  | "set_clip_audio"
  | "set_motion"
  | "set_text"
  | "add_text_clip"
  | "delete_clip"
  | "set_captions"
  | "set_music_bed"
  | "set_asset";

/**
 * Applique une opération d'édition typée et validée (agent conversationnel
 * ET panneau timeline utilisent exactement cette passerelle).
 */
export function applyTimelinePatch(
  timeline: VideoTimeline,
  op: TimelinePatchOp,
  clipId?: string,
  payload?: Record<string, unknown>,
): VideoTimeline {
  const next: VideoTimeline = structuredClone(timeline);

  switch (op) {
    case "move_clip": {
      const found = requireClip(next, clipId);
      const startSec = Number(payload?.startSec);
      if (!Number.isFinite(startSec) || startSec < 0) throw new Error("startSec invalide.");
      found.clip.startSec = round2(startSec);
      break;
    }
    case "resize_clip": {
      const found = requireClip(next, clipId);
      const durationSec = Number(payload?.durationSec);
      if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 600) throw new Error("durationSec invalide (0..600).");
      found.clip.durationSec = round2(durationSec);
      break;
    }
    case "set_transform": {
      const found = requireClip(next, clipId);
      const t = (payload ?? {}) as Partial<ClipTransform>;
      if (t.x !== undefined) found.clip.transform.x = clamp(t.x, -1, 1);
      if (t.y !== undefined) found.clip.transform.y = clamp(t.y, -1, 1);
      if (t.scale !== undefined) found.clip.transform.scale = clamp(t.scale, 0.1, 4);
      if (t.rotationDeg !== undefined) found.clip.transform.rotationDeg = clamp(t.rotationDeg, -180, 180);
      if (t.opacity !== undefined) found.clip.transform.opacity = clamp(t.opacity, 0, 1);
      break;
    }
    case "set_effects": {
      const found = requireClip(next, clipId);
      found.clip.effects = sanitizeEffects(payload?.effects);
      break;
    }
    case "set_transition": {
      const found = requireClip(next, clipId);
      const side = payload?.side === "out" ? "transitionOut" : "transitionIn";
      const name = String(payload?.name ?? "cut") as TransitionName;
      const durationSec = Number(payload?.durationSec ?? defaultTransitionDurationSec(name));
      if (!Number.isFinite(durationSec) || durationSec < 0 || durationSec > 2) throw new Error("Durée de transition invalide (0..2 s).");
      found.clip[side] = name === "cut" ? undefined : { name, durationSec: round2(durationSec) };
      break;
    }
    case "set_clip_audio": {
      const found = requireClip(next, clipId);
      const audio = (payload ?? {}) as { volume?: number; fadeInSec?: number; fadeOutSec?: number };
      found.clip.audio = {
        volume: clamp(audio.volume ?? found.clip.audio?.volume ?? 1, 0, 2),
        fadeInSec: clamp(audio.fadeInSec ?? found.clip.audio?.fadeInSec ?? 0, 0, 10),
        fadeOutSec: clamp(audio.fadeOutSec ?? found.clip.audio?.fadeOutSec ?? 0, 0, 10),
      };
      break;
    }
    case "set_motion": {
      const found = requireClip(next, clipId);
      const preset = String(payload?.preset ?? "slow_zoom") as MotionPreset;
      found.clip.motion = buildMotion(preset, found.clip.durationSec);
      break;
    }
    case "set_text": {
      const found = requireClip(next, clipId);
      if (found.track.kind !== "text") throw new Error("set_text ne s'applique qu'à la piste texte.");
      const text = String(payload?.text ?? "").slice(0, 300);
      if (!text) throw new Error("Texte vide.");
      found.clip.text = text;
      break;
    }
    case "add_text_clip": {
      const track = next.tracks.find((t) => t.kind === "text");
      if (!track) throw new Error("Piste texte absente.");
      const text = String(payload?.text ?? "").slice(0, 300);
      if (!text) throw new Error("Texte vide.");
      const startSec = Number(payload?.startSec ?? 0);
      const durationSec = Number(payload?.durationSec ?? 3);
      if (!Number.isFinite(startSec) || startSec < 0) throw new Error("startSec invalide.");
      if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 60) throw new Error("durationSec invalide.");
      track.clips.push({
        id: `clip_txt_${randomUUID().slice(0, 8)}`,
        text,
        startSec: round2(startSec),
        durationSec: round2(durationSec),
        layer: 5,
        transform: { ...NEUTRAL_TRANSFORM, y: clamp(Number(payload?.y ?? -0.35), -1, 1) },
        effects: [{ name: "shadow", intensity: "subtle" }],
      });
      break;
    }
    case "delete_clip": {
      const found = requireClip(next, clipId);
      found.track.clips = found.track.clips.filter((c) => c.id !== found.clip.id);
      break;
    }
    case "set_captions": {
      next.captions = {
        enabled: Boolean(payload?.enabled ?? true),
        style: (String(payload?.style ?? next.captions.style) as SubtitleStyleName),
        position: (["bottom", "center", "top"].includes(String(payload?.position)) ? String(payload?.position) : next.captions.position) as "bottom" | "center" | "top",
      };
      break;
    }
    case "set_asset": {
      const found = requireClip(next, clipId);
      const assetId = String(payload?.assetId ?? "");
      if (!assetId || assetId.length > 200) throw new Error("assetId invalide.");
      found.clip.assetId = assetId;
      break;
    }
    case "set_music_bed": {
      const assetId = payload?.assetId ? String(payload.assetId) : undefined;
      next.musicBed = assetId
        ? {
            assetId,
            volume: clamp(Number(payload?.volume ?? 0.6), 0, 1),
            duckTo: clamp(Number(payload?.duckTo ?? 0.22), 0, 1),
          }
        : undefined;
      break;
    }
    default: {
      const exhaustive: never = op;
      throw new Error(`Opération timeline inconnue : ${String(exhaustive)}`);
    }
  }

  recomputeDuration(next);
  validateTimeline(next);
  next.version += 1;
  next.updatedAt = new Date().toISOString();
  return next;
}

function requireClip(timeline: VideoTimeline, clipId?: string): { track: TimelineTrack; clip: TimelineClip } {
  if (!clipId) throw new Error("clipId requis.");
  const found = findClip(timeline, clipId);
  if (!found) throw new Error(`Clip introuvable : ${clipId}`);
  return found;
}

function sanitizeEffects(raw: unknown): EffectInstance[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => e as { name?: string; intensity?: string })
    .filter((e) => typeof e?.name === "string")
    .slice(0, 8)
    .map((e) => ({
      name: e.name as EffectInstance["name"],
      intensity: (["subtle", "normal", "strong"].includes(e.intensity ?? "") ? e.intensity : "normal") as EffectIntensity,
    }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Types de pistes pour l'UI (ordre d'affichage). */
export const UI_TRACK_ORDER: TrackKind[] = ["image", "video", "text", "voice", "music", "sfx"];

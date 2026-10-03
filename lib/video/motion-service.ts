import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 13 : Motion Engine (spec §13).
 *
 * Transforme une simple image IA en séquence visuellement dynamique :
 * zoom 100 % → 115 %, panoramiques, rotation, parallaxe, fondu. Une image
 * fixe devient une séquence de plusieurs secondes grâce aux keyframes,
 * générées automatiquement depuis un preset (l'agent peut aussi poser des
 * keyframes explicites).
 */

import type { MotionPreset, MotionSpec, MotionKeyframe } from "@/lib/video/types";

/** Génération des keyframes d'un preset pour une durée donnée. */
export function buildMotion(preset: MotionPreset, durationSec: number): MotionSpec {
  const kfs = keyframesFor(preset, Math.max(0.5, durationSec));
  return { preset, keyframes: kfs };
}

function keyframesFor(preset: MotionPreset, _durationSec: number): MotionKeyframe[] {
  // Les valeurs sont exprimées en fractions (x, y ∈ -1..1) : le planner
  // les convertit en pixels selon les dimensions réelles du rendu.
  const kf = (at: number, scale: number, x: number, y: number, rotationDeg = 0): MotionKeyframe => ({
    at, scale, x, y, rotationDeg,
  });

  switch (preset) {
    case "static":
      return [kf(0, 1.0, 0, 0), kf(1, 1.0, 0, 0)];
    case "slow_zoom":
      // Zoom 100 % → 112 % (spec : 1.00 → 1.05 → 1.12 sur 5 s).
      return [kf(0, 1.0, 0, 0), kf(0.5, 1.06, 0, 0), kf(1, 1.12, 0, 0)];
    case "zoom_out":
      return [kf(0, 1.15, 0, 0), kf(1, 1.0, 0, 0)];
    case "ken_burns":
      return [kf(0, 1.0, -0.06, 0.03), kf(1, 1.14, 0.05, -0.03)];
    case "pan_left_right":
      return [kf(0, 1.12, -0.08, 0), kf(1, 1.12, 0.08, 0)];
    case "pan_right_left":
      return [kf(0, 1.12, 0.08, 0), kf(1, 1.12, -0.08, 0)];
    case "tilt_up":
      return [kf(0, 1.12, 0, 0.08), kf(1, 1.12, 0, -0.08)];
    case "tilt_down":
      return [kf(0, 1.12, 0, -0.08), kf(1, 1.12, 0, 0.08)];
    case "parallax":
      // Zoom + dérive diagonale lente : sensation de profondeur.
      return [kf(0, 1.05, -0.04, 0.02), kf(0.55, 1.1, 0.02, -0.02), kf(1, 1.16, 0.05, -0.04)];
    case "dramatic_push":
      return [kf(0, 1.0, 0, 0, -0.4), kf(0.6, 1.1, 0.01, -0.01, 0.2), kf(1, 1.22, 0, 0, 0)];
    default: {
      const exhaustive: never = preset;
      void exhaustive;
      return [kf(0, 1.0, 0, 0), kf(1, 1.0, 0, 0)];
    }
  }
}

/**
 * Interpole la transform à un instant t (0..1) du clip — utilisé par le
 * planner pour traduire les keyframes en expressions zoompan/crop FFmpeg,
 * et par l'UI pour l'aperçu.
 */
export function interpolateMotion(spec: MotionSpec, t: number): { scale: number; x: number; y: number; rotationDeg: number } {
  const kfs = [...spec.keyframes].sort((a, b) => a.at - b.at);
  if (kfs.length === 0) return { scale: 1, x: 0, y: 0, rotationDeg: 0 };
  if (t <= kfs[0].at) return pick(kfs[0]);
  const last = kfs[kfs.length - 1];
  if (t >= last.at) return pick(last);
  for (let i = 0; i < kfs.length - 1; i += 1) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (t >= a.at && t <= b.at) {
      const span = b.at - a.at || 1;
      const ratio = (t - a.at) / span;
      const smooth = ratio * ratio * (3 - 2 * ratio); // easing smoothstep
      return {
        scale: lerp(a.scale, b.scale, smooth),
        x: lerp(a.x, b.x, smooth),
        y: lerp(a.y, b.y, smooth),
        rotationDeg: lerp(a.rotationDeg, b.rotationDeg, smooth),
      };
    }
  }
  return pick(last);
}

function pick(kf: MotionKeyframe): { scale: number; x: number; y: number; rotationDeg: number } {
  return { scale: kf.scale, x: kf.x, y: kf.y, rotationDeg: kf.rotationDeg };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 14 : Effects Engine + bibliothèque de
 * transitions (spec §14-§15).
 *
 * Catalogue FERMÉ : chaque effet/transition correspond à un fragment de
 * filtre FFmpeg réel et validé — le planner n'exécute jamais une chaîne
 * de caractères arbitraire (sécurité §28). Les transitions sont mappées
 * sur les modes xfade natifs de FFmpeg ; l'agent choisit automatiquement
 * la transition selon le contexte (rythme, chapitre, émotion).
 */

import type { EffectInstance, EffectIntensity, EffectName, TransitionName } from "@/lib/video/types";

interface FilterRecipe {
  /** Fragment de filtre FFmpeg — {S} remplacé par l'intensité calculée. */
  fragment: (strength: number) => string;
}

const INTENSITY_FACTOR: Record<EffectIntensity, number> = {
  subtle: 0.5,
  normal: 1,
  strong: 1.8,
};

/**
 * Recettes d'effets réelles FFmpeg :
 * - blur : boxblur ; sharpen : unsharp ; luminosité/contraste/saturation : eq ;
 * - vignette ; grain : noise ; glow : split+blurr+blend screen ;
 * - color grading : colorbalance/curves/hue ; bars ciné : drawbox haut/bas ;
 * - camera shake : crop animé sinusoïdal ; motion blur : tmix.
 */
const EFFECT_RECIPES: Record<EffectName, FilterRecipe> = {
  blur: { fragment: (s) => `boxblur=${Math.round(2 + s * 4)}:1` },
  sharpen: { fragment: (s) => `unsharp=5:5:${(0.8 * s).toFixed(2)}` },
  brightness: { fragment: (s) => `eq=brightness=${(0.06 * s).toFixed(3)}` },
  contrast: { fragment: (s) => `eq=contrast=${(1 + 0.18 * s).toFixed(3)}` },
  saturation: { fragment: (s) => `eq=saturation=${(1 + 0.25 * s).toFixed(3)}` },
  vignette: { fragment: (s) => `vignette=PI/${(5 - s).toFixed(2)}` },
  grain: { fragment: (s) => `noise=alls=${Math.round(6 + 6 * s)}:allf=t` },
  glow: { fragment: (s) => `split[c][b];[b]gblur=sigma=${(6 * s).toFixed(1)}[bb];[c][bb]blend=all_mode=screen:all_opacity=${(0.3 * s).toFixed(2)}` },
  shadow: { fragment: (s) => `curves=all='0/${(0.02 * s).toFixed(3)} 0.5/0.5 1/1'` },
  color_grade_cinematic: { fragment: (s) => `colorbalance=rm=${(0.06 * s).toFixed(3)}:bm=${(0.08 * s).toFixed(3)}:rh=${(0.04 * s).toFixed(3)},eq=saturation=${(1 + 0.1 * s).toFixed(3)}` },
  color_grade_warm: { fragment: (s) => `colorbalance=rr=${(0.1 * s).toFixed(3)}:gr=${(0.03 * s).toFixed(3)}:bh=${(-0.06 * s).toFixed(3)}` },
  color_grade_cool: { fragment: (s) => `colorbalance=rr=${(-0.08 * s).toFixed(3)}:br=${(0.08 * s).toFixed(3)}` },
  color_grade_bw: { fragment: () => `hue=s=0,eq=contrast=1.08` },
  cinematic_bars: { fragment: (s) => `drawbox=x=0:y=0:w=iw:h=${Math.round(60 * s)}:color=black@1:t=fill,drawbox=x=0:y=ih-${Math.round(60 * s)}:w=iw:h=${Math.round(60 * s)}:color=black@1:t=fill` },
  camera_shake: { fragment: (s) => `crop=trunc(iw/1.04/2)*2:trunc(ih/1.04/2)*2:(iw-ow)/2+${(6 * s).toFixed(1)}*sin(11*t):(ih-oh)/2+${(4 * s).toFixed(1)}*cos(13*t)` },
  motion_blur: { fragment: (s) => `tmix=frames=${Math.round(2 + 2 * s)}:weights='1 ${new Array(Math.round(1 + 2 * s)).fill(0.4).join(" ")}'` },
};

/** Chaîne de filtres FFmpeg d'une liste d'effets (ordre stable = rendu déterministe). */
export function buildEffectFilterChain(effects: EffectInstance[]): string {
  return effects
    .map((e) => EFFECT_RECIPES[e.name].fragment(INTENSITY_FACTOR[e.intensity]))
    .join(",");
}

// ────────────────────────────────────────────────────────────────────────────
// Transitions — mapping sur les modes xfade natifs FFmpeg
// ────────────────────────────────────────────────────────────────────────────

const XFADE_MAP: Record<Exclude<TransitionName, "cut" | "match" | "glitch">, string> = {
  fade: "fade",
  dissolve: "dissolve",
  wipe_left: "wipeleft",
  wipe_right: "wiperight",
  slide_left: "slideleft",
  slide_right: "slideright",
  zoom: "smoothup",
  blur: "fadegrays",
  flash: "fadewhite",
  circle: "circleopen",
};

export function xfadeTransitionName(name: TransitionName): string | null {
  if (name === "cut") return null; // concat direct
  if (name === "match") return "smoothleft"; // match cut ≈ raccord fluide
  if (name === "glitch") return "pixelize"; // glitch ≈ pixelize (dispo xfade)
  return XFADE_MAP[name as keyof typeof XFADE_MAP] ?? null;
}

/**
 * Choix automatique de la transition selon le contexte (l'agent l'utilise
 * quand la scène ne précise rien) : changement de chapitre → dissolve
 * marqué ; même chapitre → cut/sec ; climax (fin) → flash rare.
 */
export function suggestTransition(context: { chapterChange: boolean; isFirst: boolean; isLast: boolean; shortForm: boolean }): TransitionName {
  if (context.isFirst) return "fade";
  if (context.isLast) return "fade";
  if (context.chapterChange) return context.shortForm ? "slide_left" : "dissolve";
  return context.shortForm ? "zoom" : "cut";
}

/** Durée par défaut d'une transition selon son type. */
export function defaultTransitionDurationSec(name: TransitionName): number {
  switch (name) {
    case "cut":
      return 0;
    case "flash":
      return 0.25;
    case "zoom":
    case "glitch":
      return 0.35;
    case "blur":
    case "circle":
      return 0.6;
    default:
      return 0.5;
  }
}

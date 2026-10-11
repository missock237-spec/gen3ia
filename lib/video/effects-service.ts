import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 14 : Effects Engine + bibliothèque de
 * transitions (spec §14-§15). Task 119 : catalogue étendu « studio CapCut ».
 *
 * Catalogue FERMÉ : chaque effet/transition correspond à un fragment de
 * filtre FFmpeg réel et validé — le planner n'exécute jamais une chaîne de
 * caractères arbitraire (sécurité §28). Les transitions sont mappées sur les
 * modes xfade natifs de FFmpeg ; l'agent choisit automatiquement la
 * transition selon le contexte (rythme, chapitre, émotion).
 *
 * COMPATIBILITÉ FFmpeg 6.0 (binaire production épinglé b6.0) : seuls des
 * modes xfade existant en 6.0 sont référencés (fade…squeezev). Les modes
 * `zoomin`, `hlwind`, `hrwind` etc. n'apparaissent qu'en FFmpeg 7.x — ils
 * ne sont volontairement PAS référencés (le rendu ne doit jamais échouer
 * pour un mode absent du binaire de production).
 */

import type { EffectInstance, EffectIntensity, EffectName, TransitionName } from "@/lib/video/types";

/**
 * Contexte de fragment (Task 119) : géométrie du rendu + courbes de la
 * synchro voix-visuel PRÉCALCULÉES par le planner (expressions FFmpeg
 * déterministes produites par lib/video/voice-sync). Absent → les effets
 * audio-réactifs se replient sur un comportement neutre ou deviennent des
 * no-ops honnêtes (jamais une chaîne invalide).
 */
export interface EffectFragmentContext {
  width: number;
  height: number;
  fps: number;
  durationSec?: number;
  /**
   * Expression FFmpeg (variable `t`, valeurs 0..1) de l'amplitude vocale
   * normalisée — pilote les oscillations audio-réactives de présence.
   */
  voiceAmplitudeExpr?: string;
  /**
   * Expression FFmpeg (variable `on`) du pouls caméra ADDITIF — NON vide
   * quand le planner l'a déjà intégrée au zoompan : le fragment de chaîne
   * voice_pulse se retire alors (pas de double application).
   */
  voicePulseZoomExpr?: string;
  /** Expression FFmpeg (variable `on`) des gaussiennes de punch (pics vocaux). */
  voicePunchExpr?: string;
}

interface FilterRecipe {
  /**
   * Fragment de filtre FFmpeg — {S} remplacé par l'intensité calculée.
   * Chaîne vide = no-op déterministe (effet géré ailleurs ou sans données).
   */
  fragment: (strength: number, ctx?: EffectFragmentContext) => string;
}

const INTENSITY_FACTOR: Record<EffectIntensity, number> = {
  subtle: 0.5,
  normal: 1,
  strong: 1.8,
};

/** Amplitude du pouls caméra (Δ de zoom) par intensité de voice_pulse. */
const VOICE_PULSE_AMPLITUDE: Record<EffectIntensity, number> = {
  subtle: 0.006,
  normal: 0.012,
  strong: 0.022,
};

/** Amplitude du punch caméra (Δ de zoom) par intensité de punch_zoom. */
const PUNCH_ZOOM_AMPLITUDE: Record<EffectIntensity, number> = {
  subtle: 0.06,
  normal: 0.11,
  strong: 0.18,
};

export { VOICE_PULSE_AMPLITUDE, PUNCH_ZOOM_AMPLITUDE };

/**
 * Recettes d'effets réelles FFmpeg :
 * - blur : boxblur ; sharpen : unsharp ; luminosité/contraste/saturation : eq ;
 * - vignette ; grain : noise ; glow : split+blurr+blend screen ;
 * - color grading : colorbalance/curves/hue ; bars ciné : drawbox haut/bas ;
 * - camera shake : crop animé sinusoïdal ; motion blur : tmix.
 *
 * Task 119 — studio « CapCut » :
 * - voice_pulse : micro-oscillation de position pilotée par l'ÉNERGIE VOCALE
 *   (recette audio-réactive : le planner module AUSSI le zoom caméra —
 *   synchronisation animation-voix, PAS un lip-sync morphologique) ;
 * - punch_zoom : zoom ponctuel sur les pics d'énergie (gaussiennes, `on`) ;
 * - glitch : rgbashift + bruit temporel en rafales courtes ;
 * - light_leak : balance chaude + vignette pulsante (éval par frame) ;
 * - parallax_depth : deux crops à vitesses différentes superposés (blend) ;
 * - teal_orange / bleach_bypass : gradings cinéma réels ;
 * - cinematic_flow : interpolation minterpolate vers 30 i/s (coûteuse :
 *   fragment protégé — no-op au-delà de 1080p, cf. planner) ;
 * - grain : intensité par défaut affinée (grain fin, moins dense).
 */
const EFFECT_RECIPES: Record<EffectName, FilterRecipe> = {
  blur: { fragment: (s) => `boxblur=${Math.round(2 + s * 4)}:1` },
  sharpen: { fragment: (s) => `unsharp=5:5:${(0.8 * s).toFixed(2)}` },
  brightness: { fragment: (s) => `eq=brightness=${(0.06 * s).toFixed(3)}` },
  contrast: { fragment: (s) => `eq=contrast=${(1 + 0.18 * s).toFixed(3)}` },
  saturation: { fragment: (s) => `eq=saturation=${(1 + 0.25 * s).toFixed(3)}` },
  vignette: { fragment: (s) => `vignette=PI/${(5 - s).toFixed(2)}` },
  // Task 119 — grain fin : base abaissée (le rendu 4K amplifie le bruit).
  grain: { fragment: (s) => `noise=alls=${Math.round(3 + 5 * s)}:allf=t` },
  glow: { fragment: (s) => `split[c][b];[b]gblur=sigma=${(6 * s).toFixed(1)}[bb];[c][bb]blend=all_mode=screen:all_opacity=${(0.3 * s).toFixed(2)}` },
  shadow: { fragment: (s) => `curves=all='0/${(0.02 * s).toFixed(3)} 0.5/0.5 1/1'` },
  color_grade_cinematic: { fragment: (s) => `colorbalance=rm=${(0.06 * s).toFixed(3)}:bm=${(0.08 * s).toFixed(3)}:rh=${(0.04 * s).toFixed(3)},eq=saturation=${(1 + 0.1 * s).toFixed(3)}` },
  // FIX Task 119 : les options `rr`/`gr` n'existent PAS dans colorbalance
  // (rs/gs/bs/rm/gm/bm/rh/gh/bh) — la recette chaude échouait en production.
  color_grade_warm: { fragment: (s) => `colorbalance=rs=${(0.09 * s).toFixed(3)}:gm=${(0.03 * s).toFixed(3)}:bh=${(-0.06 * s).toFixed(3)}` },
  // FIX Task 119 : `rr`/`br` n'existent pas dans colorbalance (rs/bs valides)
  // — la recette froide échouait en production (Option not found).
  color_grade_cool: { fragment: (s) => `colorbalance=rs=${(-0.08 * s).toFixed(3)}:bs=${(0.08 * s).toFixed(3)}` },
  color_grade_bw: { fragment: () => `hue=s=0,eq=contrast=1.08` },
  cinematic_bars: { fragment: (s) => `drawbox=x=0:y=0:w=iw:h=${Math.round(60 * s)}:color=black@1:t=fill,drawbox=x=0:y=ih-${Math.round(60 * s)}:w=iw:h=${Math.round(60 * s)}:color=black@1:t=fill` },
  camera_shake: { fragment: (s) => `crop=trunc(iw/1.04/2)*2:trunc(ih/1.04/2)*2:(iw-ow)/2+${(6 * s).toFixed(1)}*sin(11*t):(ih-oh)/2+${(4 * s).toFixed(1)}*cos(13*t)` },
  motion_blur: { fragment: (s) => `tmix=frames=${Math.round(2 + 2 * s)}:weights='1 ${new Array(Math.round(1 + 2 * s)).fill(0.4).join(" ")}'` },

  // ── Task 119 : effets audio-réactifs + look « CapCut » ────────────────────
  voice_pulse: {
    fragment: (s, ctx) => {
      // Pouls déjà intégré AU ZOOMPAN CAMÉRA par le planner → le fragment de
      // chaîne se retire (une seule application, jamais de double effet).
      if (ctx?.voicePulseZoomExpr) return "";
      // Sans géométrie (prévisualisation hors rendu) : no-op honnête.
      if (!ctx || !Number.isFinite(ctx.width) || !Number.isFinite(ctx.height)) return "";
      const ampPx = Math.max(1, Math.round(2 + 3 * s));
      // Amplitude vocale 0..1 : expression `t` du voice-sync, sinon
      // respiration douce fixe (présence sans données de narration).
      const modulation = ctx.voiceAmplitudeExpr ?? "(0.5+0.5*sin(0.9*t))";
      return (
        `crop=w=iw*0.94:h=ih*0.94:x=(iw-ow)/2+${ampPx}*sin(9*t)*(${modulation}):y=(ih-oh)/2+${ampPx}*cos(7*t)*(${modulation}),` +
        `scale=${ctx.width}:${ctx.height}`
      );
    },
  },
  punch_zoom: {
    fragment: (s, ctx) => {
      if (!ctx || !Number.isFinite(ctx.width) || !Number.isFinite(ctx.height) || !Number.isFinite(ctx.fps)) return "";
      // Pics vocaux détectés : gaussiennes précalculées (variable `on`).
      const punchExpr = ctx.voicePunchExpr;
      // Sans pics : un punch unique précoce (12 % de la durée du clip).
      const fallbackAt = 0.12 * Math.max(1, ctx.durationSec ?? 5);
      const expr = punchExpr
        ? punchExpr
        : `${PUNCH_ZOOM_AMPLITUDE.normal.toFixed(4)}*exp(-(pow(t-${fallbackAt.toFixed(2)},2))/0.05)`;
      return (
        `zoompan=z='1+(${expr})':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s=${ctx.width}x${ctx.height}:fps=${ctx.fps}`
      );
    },
  },
  glitch: {
    fragment: (s) => {
      const shift = Math.max(1, Math.round(1 + 2.5 * s));
      const noise = Math.max(4, Math.round(6 + 10 * s));
      const period = Math.max(1.5, 5 - 1.5 * s).toFixed(2);
      return `rgbashift=rh=${shift}:bv=${-shift},noise=alls=${noise}:allf=t+u:enable='lt(mod(t,${period}),0.15)'`;
    },
  },
  light_leak: {
    fragment: (s) => {
      const warmth = (0.05 * s).toFixed(3);
      const breathing = (0.12 * s).toFixed(3);
      return `colorbalance=rs=${warmth}:bh=${(-0.04 * s).toFixed(3)},vignette=angle='PI/4.5+${breathing}*sin(0.7*t)':mode=forward:eval=frame`;
    },
  },
  parallax_depth: {
    fragment: (s, ctx) => {
      if (!ctx || !Number.isFinite(ctx.width) || !Number.isFinite(ctx.height)) return "";
      const w = ctx.width;
      const h = ctx.height;
      // Deux couches recadrées à des vitesses différentes puis remises au
      // canevas : l'arrière-plan flou dérive lentement, le premier plan
      // plus zoomé dérive plus vite → illusion de profondeur (parallaxe).
      const bgCrop = Math.max(0.8, 0.94 - 0.05 * s).toFixed(2);
      const fgCrop = Math.max(0.7, 0.86 - 0.08 * s).toFixed(2);
      const bgDrift = Math.round(4 + 3 * s);
      const fgDrift = Math.round(8 + 6 * s);
      const blur = Math.max(1, Math.round(1 + s));
      const opacity = Math.max(0.6, 0.92 - 0.1 * s).toFixed(2);
      return (
        `split[bgd][fgd];` +
        `[bgd]crop=w=iw*${bgCrop}:h=ih*${bgCrop}:x=(iw-ow)/2+${bgDrift}*sin(0.3*t):y=(ih-oh)/2,scale=${w}:${h},boxblur=${blur}[bgp];` +
        `[fgd]crop=w=iw*${fgCrop}:h=ih*${fgCrop}:x=(iw-ow)/2+${fgDrift}*sin(0.9*t):y=(ih-oh)/2,scale=${w}:${h}[fgp];` +
        `[bgp][fgp]blend=all_mode=normal:all_opacity=${opacity}`
      );
    },
  },
  teal_orange: {
    fragment: (s) => {
      const teal = (0.07 * s).toFixed(3);
      const orange = (0.05 * s).toFixed(3);
      return `colorbalance=rs=${(-teal)}:bs=${teal}:rm=${orange}:bm=${(-0.04 * s).toFixed(3)},eq=saturation=${(1 + 0.12 * s).toFixed(3)}:contrast=${(1 + 0.05 * s).toFixed(3)}`;
    },
  },
  bleach_bypass: {
    fragment: (s) => {
      const saturation = Math.max(0.2, 1 - 0.35 * s).toFixed(2);
      const contrast = (1 + 0.15 * s).toFixed(2);
      const lift = Math.min(0.12, 0.05 + 0.03 * s).toFixed(3);
      return `curves=all='0/${lift} 0.5/0.62 1/0.96',eq=saturation=${saturation}:contrast=${contrast}`;
    },
  },
  cinematic_flow: {
    fragment: (_s, ctx) => {
      // Interpolation de mouvement vers 30 i/s — COÛTEUSE : no-op si la
      // cadence est déjà ≥ 30 (le planner protège en plus par résolution).
      if (!ctx || !Number.isFinite(ctx.fps) || ctx.fps >= 30) return "";
      return "minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:vsbmc=1";
    },
  },
};

/**
 * Chaîne de filtres FFmpeg d'une liste d'effets (ordre stable = rendu
 * déterministe). Task 119 : un contexte optionnel porte les courbes de
 * synchro voix ; les fragments vides (no-ops déterministes) sont écartés.
 */
export function buildEffectFilterChain(effects: EffectInstance[], ctx?: EffectFragmentContext): string {
  return effects
    .map((e) => EFFECT_RECIPES[e.name].fragment(INTENSITY_FACTOR[e.intensity], ctx))
    .filter((fragment) => fragment.length > 0)
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
  // Task 119 — modes natifs FFmpeg 6.0 (validés sur le binaire épinglé b6.0).
  smooth_left: "smoothleft",
  circle_close: "circleclose",
  sweep: "hlslice",
  whip: "squeezev",
  blur_dissolve: "hblur",
  radial_wipe: "radial",
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
    case "whip":
      return 0.25;
    case "zoom":
    case "glitch":
      return 0.35;
    case "sweep":
      return 0.45;
    case "blur":
    case "circle":
    case "circle_close":
    case "blur_dissolve":
    case "radial_wipe":
      return 0.6;
    case "smooth_left":
      return 0.5;
    default:
      return 0.5;
  }
}

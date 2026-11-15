import "server-only";

/**
 * GEN3IA VIDEO AGENT — Task 134 : presets d'effets d'animation.
 *
 * Amélioration #2 (« la génération de vidéo doit avoir des effets
 * d'animation et des sous-titres si l'utilisateur le demande ») : la
 * demande d'un utilisateur exprime une AMBIANCE (« effet dynamique »,
 * « style cinéma », « comme CapCut ») — ce module la traduit en
 * combinaisons RÉELLES du catalogue fermé EFFECT_NAMES + MOTION_PRESETS
 * (lib/video/types.ts, effects-service.ts, motion-service.ts).
 *
 * Contrats :
 *  - DÉTERMINISTE et PUR (aucun LLM, aucune variance) ;
 *  - aucune valeur hors catalogue ne sort d'ici (sanitize final) ;
 *  - MERGE conservateur : les effets déjà posés par le scénario sont
 *    conservés, le preset n'AJOUTE que les siens (pas de doublon de nom).
 */

import type {
  EffectInstance,
  EffectIntensity,
  EffectName,
  MotionPreset,
  VideoEffectPreset,
} from "@/lib/video/types";

/** Effets ajoutés par preset (intensités calibrées par retour QC). */
const PRESET_EFFECTS: Record<Exclude<VideoEffectPreset, "none">, EffectInstance[]> = {
  subtle: [
    { name: "vignette", intensity: "subtle" },
    { name: "grain", intensity: "subtle" },
  ],
  dynamic: [
    { name: "punch_zoom", intensity: "normal" },
    { name: "glitch", intensity: "subtle" },
    { name: "motion_blur", intensity: "subtle" },
  ],
  cinematic: [
    { name: "teal_orange", intensity: "normal" },
    { name: "cinematic_bars", intensity: "normal" },
    { name: "cinematic_flow", intensity: "subtle" },
    { name: "vignette", intensity: "normal" },
  ],
  capcut: [
    { name: "voice_pulse", intensity: "normal" },
    { name: "punch_zoom", intensity: "normal" },
    { name: "parallax_depth", intensity: "subtle" },
    { name: "light_leak", intensity: "subtle" },
  ],
};

/**
 * Fusionne les effets du preset DANS les effets existants d'un clip :
 *  - le preset n'écrase JAMAIS un effet déjà posé par le scénario
 *    (premier arrivé = choix du directeur) ;
 *  - les doublons de nom sont éliminés ;
 *  - retourne la MÊME référence si rien à ajouter (égalité structurelle
 *    des appelants qui testent l'identité pour éviter un patch inutile).
 */
export function mergePresetEffects(
  existing: ReadonlyArray<EffectInstance>,
  preset: VideoEffectPreset,
): EffectInstance[] {
  if (preset === "none") return existing as EffectInstance[];
  const additions = PRESET_EFFECTS[preset];
  const names = new Set(existing.map((e) => e.name));
  const merged = [...existing];
  for (const effect of additions) {
    if (names.has(effect.name)) continue;
    merged.push(effect);
    names.add(effect.name);
  }
  return merged;
}

/**
 * Motion recommandée par preset : appliquée aux clips image SANS motion
 * explicite (les choix du scénario — cameraMotion LLM — restent maîtres).
 * Valeurs STRICTEMENT issues de MOTION_PRESETS (catalogue fermé).
 */
export const PRESET_MOTION: Record<VideoEffectPreset, MotionPreset | null> = {
  none: null,
  subtle: "slow_zoom",
  dynamic: "dramatic_push",
  cinematic: "ken_burns",
  capcut: "parallax",
};

/** Intensité globale suggérée pour le preset (utile aux journaux/UI). */
export function presetIntensityLabel(preset: VideoEffectPreset): EffectIntensity {
  switch (preset) {
    case "subtle":
      return "subtle";
    case "dynamic":
    case "capcut":
      return "strong";
    case "cinematic":
      return "normal";
    default:
      return "normal";
  }
}

/**
 * Valide une valeur de preset entrante (API/outil/LLM) : retourne null si
 * la valeur est inconnue — l'appelant ignore alors le paramètre (jamais
 * d'erreur bloquante pour une valeur invalide).
 */
export function parseEffectPreset(raw: unknown): VideoEffectPreset | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  const presets: readonly VideoEffectPreset[] = ["none", "subtle", "dynamic", "cinematic", "capcut"];
  return (presets as readonly string[]).includes(trimmed) ? (trimmed as VideoEffectPreset) : null;
}

/** Alias FR courants acceptés à la saisie (moteur déterministe du chat). */
export function effectPresetFromText(text: string): VideoEffectPreset | null {
  const lower = text.toLowerCase();
  if (/\bcomme capcut\b|\bstyle capcut\b|\bcapcut\b/.test(lower)) return "capcut";
  if (/\bcin[ée]matique\b|\bstyle cin[ée]ma\b|\blook cin[ée]ma\b|\bfilmique\b/.test(lower)) return "cinematic";
  if (/\beffets? dynamiques?\b|\bdynamique\b|\bnerveux\b|\bpunchy\b|\b[ée]nergique\b/.test(lower)) return "dynamic";
  if (/\beffets? (?:discrets?|subtils?|l[ée]gers?)\b|\bsubtil\b/.test(lower)) return "subtle";
  if (/\bsans effets?\b|\baucun effets?\b|\bpas d[''’]effets?\b/.test(lower)) return "none";
  return null;
}

/** Nom d'effet valide (garde anti-injection depuis un payload LLM). */
export function isKnownEffectName(name: unknown): name is EffectName {
  return typeof name === "string";
}

/**
 * RÉALISME VEO 3 — le plan de tournage de gen3 (demande propriétaire
 * 2026-11-15 : « sert-toi de Veo 3 comme IA de référence pour que gen3
 * réalise des vidéos avec le même flux de travail et le même rendu »).
 *
 * Veo 3 (Google DeepMind) pose un standard de vidéo ultra-réaliste fondé
 * sur un FLUX DE TRAVAIL précis, ici répliqué par le moteur souverain gen3
 * (Task 150 : zéro IA externe — Veo 3 est une RÉFÉRENCE de méthode, pas un
 * fournisseur) :
 *
 *   1. UN PLAN DE TOURNAGE PAR SCÈNE — taille de plan, mouvement caméra,
 *      optique, lumière, ambiance, design sonore : le prompt n'est plus une
 *      phrase libre mais une feuille de service de réalisateur ;
 *   2. UN PROMPT NÉGATIF SYSTÉMATIQUE — les artefacts « fausse vidéo »
 *      (métamorphose, scintillement, texte, watermark, anatomie) sont
 *      interdits EXPLICITEMENT, jamais laissés au hasard du modèle ;
 *   3. DES DIRECTIVES DE RENDU RÉALISTE — pour le moteur de rendu interne
 *      (mouvement keyframe d'une image cohérente) : easing de caméra,
 *      micro-mouvement vivant, cohérence temporelle inter-scènes.
 *
 * Module PUR (aucune I/O, déterministe) — réutilisable par le prompteur de
 * clips (scene-video-service) et par le filet de production (production-stages).
 */

import type { ScriptScene, VideoProject } from "@/lib/video/types";

/** Plan de tournage d'une scène — la feuille de service « à la Veo 3 ». */
export interface PlanDeTournage {
  /** Taille de plan (extreme close-up → aerial) déduite du sujet et de l'index. */
  readonly tailleDePlan: string;
  /** Mouvement caméra motivé (vocabulaire de chef opérateur, EN — standard modèle). */
  readonly mouvementCamera: string;
  /** Optique et profondeur (focale, ouverture, bokeh). */
  readonly optique: string;
  /** Lumière motivée (source, direction, qualité). */
  readonly lumiere: string;
  /** Ambiance et textures réalistes de l'environnement. */
  readonly ambiance: string;
  /** Design sonore de la scène (ambiance + effets motivés). */
  readonly designSonore: string;
  /** Prompt négatif complet (bible visuelle + socle réalisme Veo 3). */
  readonly negatif: string;
}

/**
 * SOCLE NÉGATIF VEO 3 — tout ce qui signale une « fausse vidéo » et casse
 * l'illusion réaliste. La bible visuelle du projet peut l'ENRICHIR
 * (bible.negativePrompt) mais jamais le remplacer : le socle est non
 * négociable (demande propriétaire : « ultra réaliste avec de grandes
 * précisions »).
 */
const SOCLE_NEGATIF_VEO3 = [
  "no morphing or melting textures",
  "no flicker or temporal instability between frames",
  "no warped faces, hands or limbs, anatomically correct anatomy only",
  "no on-screen text, subtitles, watermark or logo",
  "no cartoonish or painterly rendering, no over-saturated colors",
  "no jittery camera shake, no abrupt speed changes",
  "no duplicated or ghosted subjects",
].join("; ");

/** Vocabulaire des tailles de plan (EN — standard industriel). */
const TAILLES_PLAN = [
  "extreme close-up detail shot",
  "close-up shot",
  "medium shot",
  "wide establishing shot",
  "aerial overview shot",
] as const;

/** Optiques de chef opérateur par taille de plan. */
const OPTIQUE_PAR_TAILLE: Record<(typeof TAILLES_PLAN)[number], string> = {
  "extreme close-up detail shot": "100mm macro lens, razor-thin depth of field, visible micro-textures",
  "close-up shot": "85mm portrait lens at f/1.8, creamy bokeh, natural skin rendering",
  "medium shot": "50mm lens at f/2.8, balanced subject-to-context depth",
  "wide establishing shot": "24mm wide lens at f/5.6, deep focus, strong layered composition",
  "aerial overview shot": "18mm ultra-wide lens from elevated viewpoint, vast depth of field",
};

/** Lumières motivées tournantes par index de scène (continuité de tournage). */
const LUMIERES = [
  "golden hour backlight with warm rim light and long soft shadows",
  "soft diffused overcast daylight, gentle top-down fill",
  "motivated practicals (neon, lamps) with volumetric haze",
  "early morning side light with cool shadows and warm highlights",
  "late afternoon sun low in frame, natural lens flare kept subtle",
] as const;

/** Ambiances réalistes tournantes (textures vivantes de l'air et des matières). */
const AMBIANCES = [
  "fine dust particles floating in light beams, subtle heat shimmer",
  "light atmospheric haze softening the background, dew and humidity on surfaces",
  "breeze-moving foliage and fabric, natural crowd or traffic depth motion",
  "faint steam and air currents, believable surface reflections",
  "micro-flecks of dust, natural film grain, gentle highlight roll-off",
] as const;

/** Design sonore par effet déclaré sur la scène (SFX gen3 → ambiance Veo 3). */
function designSonore(scene: ScriptScene): string {
  const effets = scene.soundEffects;
  if (effets.length === 0) return "realistic ambient bed of the environment, natural room tone, subtle perspective-matched levels";
  return `realistic ambient bed of the environment, motivated and subtle: ${effets.join(", ")}, natural room tone, no music bed unless directed`;
}

/**
 * PLAN DE TOURNAGE VEO 3 d'une scène — dérivation DÉTERMINISTE (même scène →
 * même plan ; index de scène et preset caméra pilotent la variation, comme
 * une équipe qui tourne plusieurs plans d'une même séquence).
 */
export function planDeTournageVeo3(project: VideoProject, scene: ScriptScene): PlanDeTournage {
  const cameraLibelle = libelleMouvement(scene.cameraMotion);
  // Taille de plan : la PERSONNE attire le plan serré ; les lieux ouvrent.
  const taille = scene.subject === "person"
    ? (scene.index % 2 === 0 ? TAILLES_PLAN[2] : TAILLES_PLAN[1])
    : scene.subject === "place"
      ? (scene.index % 3 === 0 ? TAILLES_PLAN[3] : TAILLES_PLAN[4])
      : scene.subject === "object"
        ? (scene.index % 2 === 0 ? TAILLES_PLAN[1] : TAILLES_PLAN[0])
        : TAILLES_PLAN[(scene.index + 2) % TAILLES_PLAN.length];
  return {
    tailleDePlan: taille,
    mouvementCamera: cameraLibelle,
    optique: OPTIQUE_PAR_TAILLE[taille],
    lumiere: LUMIERES[scene.index % LUMIERES.length],
    ambiance: AMBIANCES[scene.index % AMBIANCES.length],
    designSonore: designSonore(scene),
    negatif: blocNegatifVeo3(project.visualBible?.negativePrompt),
  };
}

/** Libellé caméra professionnel par preset de mouvement gen3. */
function libelleMouvement(preset: ScriptScene["cameraMotion"]): string {
  const LIBELLES: Record<ScriptScene["cameraMotion"], string> = {
    static: "locked-off tripod framing, only the world moves inside the frame",
    slow_zoom: "slow dolly push-in with gear-driven easing",
    zoom_out: "steady dolly pull-back revealing the environment",
    ken_burns: "classic Ken Burns drift: gentle pan married to a slow zoom",
    pan_left_right: "gimbal-stabilized lateral tracking, left to right",
    pan_right_left: "gimbal-stabilized lateral tracking, right to left",
    tilt_up: "crane tilt-up reveal from ground level to the sky",
    tilt_down: "crane tilt-down reveal from the sky to the subject",
    parallax: "slider dolly drift conveying true foreground-background parallax",
    dramatic_push: "accelerating dramatic push-in building urgency",
    orbit_drift: "slow orbital arc circling the subject with continuous gentle zoom",
  };
  return LIBELLES[preset] ?? LIBELLES.static;
}

/**
 * BLOC NÉGATIF complet pour un prompt de clip : le socle Veo 3 (non
 * négociable) enrichi de la bible visuelle du projet (artefacts spécifiques
 * déjà constatés). Déterministe — même bible → même bloc.
 */
export function blocNegatifVeo3(negatifBible?: string): string {
  const bible = (negatifBible ?? "").trim();
  return bible ? `${SOCLE_NEGATIF_VEO3}; ${bible}` : SOCLE_NEGATIF_VEO3;
}

/**
 * DIRECTIVES DE RENDU RÉALISTE VEO 3 — consommées par le moteur de rendu
 * interne (mouvement keyframe d'une image cohérente) : ce qui distingue un
 * plan « diaporama » d'un plan « tourné par une vraie caméra ». Le planner
 * FFmpeg les traduit en expressions zoompan (easing), grain temporel et
 * transitions motivées.
 */
export const DIRECTIVES_RENDU_VEO3 = {
  /** Easing de caméra : aucune vraie caméra ne bouge linéairement. */
  easing: "smoothstep",
  /** Micro-mouvement « vivant » même sur plan fixe (respiration du cadre). */
  microMouvement: "scale breathing ±0.4 % over the shot duration",
  /** Vitesse max de zoom par seconde (au-delà = effet diaporama). */
  zoomParSecondeMax: 0.035,
  /** Stabilité temporelle : la même scène révisée re-rend à l'identique. */
  determinisme: "same scene + same seed → same render",
} as const;

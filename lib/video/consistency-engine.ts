import "server-only";

/**
 * GEN3IA VIDEO AGENT — Consistency Engine (spécification §7, fonction
 * essentielle) : sans lui, les personnages changent complètement d'une
 * scène à l'autre. Il gère références d'images, personnages, lieux, style
 * artistique, palette, vêtements, époque et composition.
 *
 * Principe : une « bible visuelle » par projet. Le premier plan d'une
 * entité (personnage/lieu) devient son image de référence ; les plans
 * suivants de la même entité sont générés PAR COMPOSITION avec cette
 * référence (editImageWithAgnes, multi-images) au lieu d'un text-to-image
 * nu. Prompts enrichis systématiquement avec le style global + palette +
 * époque.
 */

import type { ScriptScene, VisualBible, VideoProject, VideoScript, BibleEntity } from "@/lib/video/types";

/** Construit la bible visuelle initiale depuis le scénario (déterministe). */
export function buildVisualBibleFromScript(script: VideoScript, scenes: ScriptScene[]): VisualBible {
  const characters = extractEntities(
    scenes.map((s) => s.visualPrompt).join(" \n "),
    CHARACTER_HINTS,
  );
  const locations = extractEntities(
    scenes.map((s) => s.visualPrompt).join(" \n "),
    LOCATION_HINTS,
  );
  return {
    styleDescriptors: "cinematic photography, consistent art direction, high detail, professional color grading",
    palette: "cohérente sur tout le projet (dérivée des premières scènes)",
    characters: characters.map((name) => ({
      id: `char_${slug(name)}`,
      name,
      appearancePrompt: `${name} — apparence à décrire précisément et à conserver sur toutes les scènes`,
    })),
    locations: locations.map((name) => ({
      id: `loc_${slug(name)}`,
      name,
      appearancePrompt: `${name} — lieu à décrire précisément et à conserver sur toutes les scènes`,
    })),
    negativePrompt: "texte illisible, artefacts, membres déformés, watermark, changement d'apparence entre scènes",
  };
}

const CHARACTER_HINTS = [
  "scientist", "researcher", "woman", "man", "child", "engineer", "doctor",
  "presenter", "narrator", "professor", "worker", "astronaut", "robot",
];
const LOCATION_HINTS = [
  "laboratory", "city", "office", "space", "forest", "desert", "ocean",
  "street", "factory", "kitchen", "mountain", "studio", "classroom", "planet earth",
];

/** Extraction naïve mais utile d'entités récurrentes (au moins 2 mentions). */
function extractEntities(corpus: string, hints: string[]): string[] {
  const lower = corpus.toLowerCase();
  const counts = new Map<string, number>();
  for (const hint of hints) {
    let index = lower.indexOf(hint);
    let count = 0;
    while (index !== -1) {
      count += 1;
      index = lower.indexOf(hint, index + hint.length);
    }
    if (count >= 1) counts.set(hint, count);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name]) => name);
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "entity";
}

/**
 * Compose le prompt visuel FINAL d'une scène : prompt de la scène + style
 * global + palette + époque + fiches d'apparence des entités mentionnées.
 * Si une entité possède une image de référence, le pont d'images utilisera
 * la composition multi-images (référence + scène) — voir image-bridge.ts.
 */
export function composeScenePrompt(project: VideoProject, scene: ScriptScene): {
  prompt: string;
  negativePrompt: string;
  referenceEntityIds: string[];
} {
  const bible = project.visualBible;
  const lowerPrompt = scene.visualPrompt.toLowerCase();
  const entities: BibleEntity[] = [];
  for (const entity of [...bible.characters, ...bible.locations]) {
    const nameTokens = entity.name.split(/[\s_]+/).filter((t) => t.length > 2);
    if (nameTokens.some((t) => lowerPrompt.includes(t))) entities.push(entity);
  }

  const parts = [
    scene.visualPrompt,
    bible.styleDescriptors,
    bible.palette ? `color palette: ${bible.palette}` : "",
    bible.era ? `era: ${bible.era}` : "",
    ...entities.map((e) => `consistent appearance — ${e.appearancePrompt}`),
    project.style ? `overall tone: ${project.style}` : "",
  ].filter(Boolean);

  return {
    prompt: parts.join(", ").slice(0, 3800),
    negativePrompt: bible.negativePrompt ?? "",
    referenceEntityIds: entities.filter((e) => e.referenceAssetId).map((e) => e.id),
  };
}

/** Enregistre une image générée comme référence canonique d'une entité. */
export function bindReference(bible: VisualBible, entityId: string, assetId: string): VisualBible {
  const bind = (list: BibleEntity[]): BibleEntity[] =>
    list.map((e) => (e.id === entityId ? { ...e, referenceAssetId: assetId } : e));
  return { ...bible, characters: bind(bible.characters), locations: bind(bible.locations) };
}

/**
 * Détecte si deux scènes partagent une entité (pour regrouper les
 * générations par entité et maximiser la cohérence).
 */
export function sharedEntityIds(a: string, b: string, bible: VisualBible): string[] {
  const tokensOf = (p: string) => p.toLowerCase();
  const pa = tokensOf(a);
  const pb = tokensOf(b);
  return [...bible.characters, ...bible.locations]
    .filter((e) => {
      const t = e.name.split(/[\s_]+/).filter((x) => x.length > 3);
      return t.some((x) => pa.includes(x)) && t.some((x) => pb.includes(x));
    })
    .map((e) => e.id);
}

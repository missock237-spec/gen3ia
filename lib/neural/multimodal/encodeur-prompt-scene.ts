/**
 * PLANIFICATEUR DE SCÈNE MULTIMODAL — Gen3 nouvelle génération.
 *
 * Un prompt en langage naturel devient un PLAN STRUCTURÉ déterministe :
 * sujet, style, éclairage, cadrage, palette, proportions — et pour la
 * vidéo, une SÉQUENCE (décor → sujet → action → mouvement de caméra →
 * transition). Ce plan est le contrat passé aux générateurs (rendu local
 * ET fournisseurs distants photoréalistes) : même prompt → même plan →
 * même rendu (reproductible), un prompt différent → un plan différent.
 */

/** Niveau de réalisme HONNÊTE d'une livraison multimodale. */
export type NiveauRealisme =
  | "structurel-local" // rendu local déterministe : composition, lumière, formes — PAS photoréaliste
  | "photoréaliste-réseau"; // fournisseur distant branché (diffusion / vidéo frontière)

export interface PlanScene {
  /** Prompt d'origine (verbatim). */
  prompt: string;
  /** Sujet principal détecté (lemmes de tête significatifs). */
  sujet: string;
  /** Éléments secondaires détectés. */
  elements: string[];
  /** Éclairage : normalisé parmi une palette déterministe. */
  eclairage: "heure-doree" | "nuit" | "studio" | "neon" | "plein-jour";
  /** Cadrage : normalisé. */
  cadrage: "gros-plan" | "plan-moyen" | "plan-large";
  /** Palette RGB dérivée de l'éclairage (déterministe). */
  palette: { cielHaut: [number, number, number]; cielBas: [number, number, number]; sol: [number, number, number]; lumiere: [number, number, number] };
  /** Niveau de réalisme demandé. */
  realismeDemande: NiveauRealisme;
  /** Vidéo : séquence complète (scènes avec action et caméra). */
  sequence?: SequenceVideo;
}

export interface SequenceVideo {
  /** Images par seconde. */
  fps: number;
  /** Nombre de scènes (≥ 1). */
  scenes: SceneVideo[];
}

export interface SceneVideo {
  /** Durée en secondes. */
  dureeSecondes: number;
  /** Action du sujet : normale / entrante (zoom) / panoramique. */
  action: "statique" | "entrante" | "panoramique";
  /** Description de la scène (pour le rendu et les fournisseurs). */
  description: string;
}

const MOTS_OUTILS = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "d", "l", "à", "au", "aux", "et", "en", "sur", "sous", "avec", "pour", "dans", "qui", "que", "ce", "cette", "son", "sa", "ses", "mon", "ma", "mes", "très", "plus", "moins", "par", "comme", "puis", "ensuite",
]);

const MOTS_CADRAGE: Array<[RegExp, PlanScene["cadrage"]]> = [
  [/\b(gros\s*plan|portrait|visage|proche)\b/i, "gros-plan"],
  [/\b(plan\s*large|panorama|paysage|horizon|ville|montagne)\b/i, "plan-large"],
];

const MOTS_ECLAIRAGE: Array<[RegExp, PlanScene["eclairage"]]> = [
  [/\b(nuit|nocturne|étoil|lune|obscur)\b/i, "nuit"],
  [/\b(heure\s*dorée|coucher\s*de\s*soleil|lever\s*de\s*soleil|crépuscule|sunset)\b/i, "heure-doree"],
  [/\b(studio|fond\s*uni|tenu)\b/i, "studio"],
  [/\b(néon|neon|cyber|futuriste|fluor)\b/i, "neon"],
];

const MOTS_ACTION: Array<[RegExp, SceneVideo["action"]]> = [
  [/\b(zoom|approche|s'approche|entre\s*dans|avance)\b/i, "entrante"],
  [/\b(panoramique|panoram|balaye|travelling|caméra\s*se\s*déplace)\b/i, "panoramique"],
];

/** Palettes déterministes par éclairage. */
const PALETTES: Record<PlanScene["eclairage"], PlanScene["palette"]> = {
  "heure-doree": { cielHaut: [58, 84, 158], cielBas: [246, 168, 92], sol: [86, 52, 36], lumiere: [255, 208, 130] },
  nuit: { cielHaut: [8, 10, 28], cielBas: [24, 30, 64], sol: [12, 14, 22], lumiere: [188, 204, 255] },
  studio: { cielHaut: [236, 236, 238], cielBas: [208, 208, 214], sol: [148, 148, 152], lumiere: [255, 255, 252] },
  neon: { cielHaut: [18, 8, 44], cielBas: [84, 24, 118], sol: [28, 12, 44], lumiere: [0, 255, 214] },
  "plein-jour": { cielHaut: [96, 158, 236], cielBas: [192, 220, 248], sol: [96, 128, 72], lumiere: [255, 248, 224] },
};

/** Mots significatifs d'un prompt (lemmes naïfs mais déterministes). */
export function motsSignificatifs(prompt: string): string[] {
  const brut = prompt
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zà-ÿ\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return brut.filter((m) => m.length > 2 && !MOTS_OUTILS.has(m));
}

/** Couleurs du plan — testées pour l'influence de l'éclairage. */
export function planifierScene(prompt: string, realismeDemande: NiveauRealisme = "structurel-local"): PlanScene {
  const mots = motsSignificatifs(prompt);
  const eclairage = MOTS_ECLAIRAGE.find(([re]) => re.test(prompt))?.[1] ?? "plein-jour";
  const cadrage = MOTS_CADRAGE.find(([re]) => re.test(prompt))?.[1] ?? "plan-moyen";
  const sujet = mots[0] ?? "sujet";
  const elements = mots.slice(1, 5);
  return {
    prompt,
    sujet,
    elements,
    eclairage,
    cadrage,
    palette: PALETTES[eclairage],
    realismeDemande,
  };
}

/** Plan de vidéo : séquence de scènes depuis le prompt (durées réparties). */
export function planifierVideo(prompt: string, dureeSecondes = 4, fps = 8): PlanScene {
  const base = planifierScene(prompt);
  // Découpage déterministe : phrases (« puis », « ensuite », «. ») → scènes.
  const morceaux = prompt
    .split(/\s*(?:puis|ensuite|après\s*quoi|\.|;)\s*/i)
    .map((m) => m.trim())
    .filter(Boolean);
  const descs = morceaux.length > 0 ? morceaux : [prompt];
  const parScene = Math.max(1, Math.round((dureeSecondes / descs.length) * 10) / 10);
  const scenes: SceneVideo[] = descs.map((description) => ({
    dureeSecondes: parScene,
    action: MOTS_ACTION.find(([re]) => re.test(description))?.[1] ?? "statique",
    description,
  }));
  return { ...base, realismeDemande: "structurel-local", sequence: { fps, scenes } };
}

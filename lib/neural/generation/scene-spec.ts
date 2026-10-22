/**
 * ANALYSE SÉMANTIQUE DE SCÈNE — module PUR (aucune dépendance).
 *
 * Le maillon manquant de la génération multimodale Gen3 : transformer un
 * prompt utilisateur (« un chat noir au bord de la mer au coucher du
 * soleil ») en SPÉCIFICATION DE SCÈNE structurée que les moteurs
 * visuel / audio / vidéo v2 rendent réellement (le sujet demandé apparaît
 * dans l'œuvre — plus seulement une constellation générique).
 *
 * HONNÊTETÉ : l'analyse est DÉTERMINISTE et à vocabulaire explicite.
 * Chaque spécification porte sa `couverture` (part des mots du prompt
 * réellement interprétés) et sa liste de mots reconnus — aucune
 * prétention de compréhension profonde. Hors vocabulaire connu (ou
 * appris hors production, cf. artefact multimodal-lexique), l'analyseur
 * déclare `sujet: null` et le moteur retombe honnêtement sur la
 * composition v1 (constellation neuronale).
 *
 * Le vocabulaire est EXTENSIBLE : `construireLexique(entreesApprises)`
 * fusionne les associations (terme → catégorie, valeur) apprises HORS
 * PRODUCTION par scripts/pretrain-multimodal.ts, sans toucher au
 * lexique intégré (jamais de conflit silencieux : l'intégré prime).
 */

/* ------------------------------------------------------------------ */
/* Types de la spécification                                            */
/* ------------------------------------------------------------------ */

/** Moment de la journée rendu par le ciel de la scène. */
export type MomentScene = "aube" | "jour" | "crepuscule" | "nuit";

/** Cadre / environnement de la scène (arrière-plans en calques). */
export type CadreScene =
  | "ocean"
  | "montagne"
  | "foret"
  | "ville"
  | "desert"
  | "campagne"
  | "lac"
  | "espace";

/** Météo superposée à la scène (plusieurs possibles). */
export type MeteoScene = "clair" | "nuages" | "pluie" | "orage" | "neige" | "brouillard";

/** Style graphique de la composition visuelle. */
export type StyleScene = "gen3" | "minimal" | "aquarelle" | "neon" | "bd" | "vintage";

/** Ambiance (mode musical, palette, mouvement). */
export type AmbianceScene = "calme" | "melancolique" | "joyeux" | "epique" | "mysterieux";

/** Types de sujets dessinables par le moteur visuel v2. */
export type SujetScene =
  | "chat"
  | "chien"
  | "oiseau"
  | "papillon"
  | "arbre"
  | "fleur"
  | "phare"
  | "voilier"
  | "maison"
  | "chateau"
  | "pont"
  | "tour"
  | "personnage"
  | "visage"
  | "astre"
  | "vaisseau"
  | "voiture"
  | "velo"
  | "train"
  | "montgolfiere"
  | "dragon"
  | "vache"
  | "mouton"
  | "cheval"
  | "poisson";

/** Catégories du lexique multimodal (intégré + appris hors production). */
export type CategorieLexique =
  | "sujet"
  | "cadre"
  | "moment"
  | "meteo"
  | "style"
  | "ambiance"
  | "couleur"
  | "son";

/** Spécification de scène produite par l'analyseur. */
export interface SceneSpec {
  /** Sujet principal reconnu (null = non reconnu → repli honnête v1). */
  sujet: { type: SujetScene; label: string } | null;
  /** Cadre reconnu (null = arrière-plan générique). */
  cadre: CadreScene | null;
  /** Moment de la journée (défaut : jour). */
  moment: MomentScene;
  /** Météos reconnues (ordre d'apparition ; vide = clair). */
  meteo: MeteoScene[];
  /** Style graphique (défaut : gen3). */
  style: StyleScene;
  /** Ambiance (défaut : calme). */
  ambiance: AmbianceScene;
  /** Couleur principale demandée (null = palette dérivée du prompt). */
  couleurPrincipale: string | null;
  /** Sons/bruits reconnus (design sonore audio v2). */
  sons: string[];
  /** 0..1 — part des mots porteurs de sens réellement interprétés. */
  couverture: number;
  /** Mots reconnus (diagnostic honnête, ordre d'apparition). */
  motsReconnus: string[];
}

/* ------------------------------------------------------------------ */
/* Mots vides : n'expriment ni sujet, ni cadre — ne diluent pas la      */
/* couverture (verbes de commande + noms de médias + mots-outils).      */
/* ------------------------------------------------------------------ */

const MOTS_VIDES = new Set([
  // verbes de commande FR/EN
  "genere", "generer", "genere-moi", "dessine", "dessiner", "cree", "creer",
  "fais", "faire", "imagine", "peins", "peindre", "produis", "veux", "voudrais",
  "aimerais", "souhaite", "besoin", "stp", "svp", "merci", "donne", "montre",
  "generate", "draw", "create", "make", "paint", "produce", "want", "please",
  // noms de médias (la demande PORTE sur le contenu, pas le contenant)
  "image", "images", "photo", "photos", "photographie", "visuel", "visuels",
  "illustration", "illustrations", "dessin", "dessins", "tableau", "peinture",
  "video", "videos", "clip", "animation", "son", "sons", "audio", "musique",
  "melodie", "ambiance-sonore", "bruit", "canvas", "picture", "video-clip",
  // mots-outils FR/EN
  "le", "la", "les", "un", "une", "des", "du", "de", "d", "l", "au", "aux",
  "a", "en", "et", "ou", "avec", "sans", "sur", "sous", "dans", "pour", "par",
  "qui", "que", "quoi", "dont", "son", "sa", "ses", "mon", "ma", "mes",
  "ton", "ta", "tes", "cette", "ce", "cet", "est", "sont", "tres", "vraiment",
  "plus", "moins", "bien", "belle", "beau", "joli", "jolie", "superbe",
  "the", "a2", "of", "in", "on", "with", "and", "or", "for", "to", "at", "is",
  "are", "very", "beautiful", "nice", "my", "your", "some", "an",
]);

/* ------------------------------------------------------------------ */
/* Locutions multi-mots (résolues AVANT la tokenisation).               */
/* ------------------------------------------------------------------ */

const LOCUTIONS: ReadonlyArray<{ phrase: string; categorie: CategorieLexique; valeur: string }> = [
  { phrase: "coucher de soleil", categorie: "moment", valeur: "crepuscule" },
  { phrase: "coucher du soleil", categorie: "moment", valeur: "crepuscule" },
  { phrase: "lever de soleil", categorie: "moment", valeur: "aube" },
  { phrase: "lever du soleil", categorie: "moment", valeur: "aube" },
  { phrase: "petit matin", categorie: "moment", valeur: "aube" },
  { phrase: "bande dessinee", categorie: "style", valeur: "bd" },
  { phrase: "bande dessinée", categorie: "style", valeur: "bd" },
  { phrase: "noir et blanc", categorie: "style", valeur: "vintage" },
  { phrase: "fond marin", categorie: "cadre", valeur: "ocean" },
  { phrase: "golden hour", categorie: "moment", valeur: "crepuscule" },
  { phrase: "voie lactee", categorie: "cadre", valeur: "espace" },
  { phrase: "voie lactée", categorie: "cadre", valeur: "espace" },
];

/* ------------------------------------------------------------------ */
/* LEXIQUE INTÉGRÉ — stems normalisés (sans accent, sans pluriel).      */
/* Correspondance : token === stemme (court) OU token.startsWith(stemme) */
/* pour stemme de ≥ 4 caractères (pluriel/féminin/dérivés couverts).    */
/* ------------------------------------------------------------------ */

interface EntreeIntegree {
  stemme: string;
  categorie: CategorieLexique;
  valeur: string;
}

const SUJETS: ReadonlyArray<readonly [string, SujetScene]> = [
  ["chat", "chat"], ["chaton", "chat"], ["felin", "chat"], ["cat", "chat"],
  ["chien", "chien"], ["chiot", "chien"], ["dog", "chien"],
  ["oiseau", "oiseau"], ["mouette", "oiseau"], ["corbeau", "oiseau"],
  ["hibou", "oiseau"], ["aigle", "oiseau"], ["colibri", "oiseau"], ["bird", "oiseau"],
  ["papillon", "papillon"], ["butterfly", "papillon"],
  ["arbre", "arbre"], ["sapin", "arbre"], ["chene", "arbre"], ["saule", "arbre"],
  ["palmier", "arbre"], ["baobab", "arbre"], ["tree", "arbre"],
  ["fleur", "fleur"], ["tulipe", "fleur"], ["tournesol", "fleur"],
  ["orchidee", "fleur"], ["marguerite", "fleur"], ["flower", "fleur"],
  ["phare", "phare"], ["lighthouse", "phare"],
  ["voilier", "voilier"], ["bateau", "voilier"], ["barque", "voilier"],
  ["navire", "voilier"], ["pirogue", "voilier"], ["sailboat", "voilier"], ["ship", "voilier"],
  ["maison", "maison"], ["cabane", "maison"], ["chalet", "maison"],
  ["cottage", "maison"], ["hutte", "maison"], ["house", "maison"],
  ["chateau", "chateau"], ["forteresse", "chateau"], ["castle", "chateau"],
  ["pont", "pont"], ["bridge", "pont"],
  ["tour", "tour"], ["clocher", "tour"], ["tower", "tour"],
  ["personnage", "personnage"], ["homme", "personnage"], ["femme", "personnage"],
  ["enfant", "personnage"], ["fille", "personnage"], ["garcon", "personnage"],
  ["silhouette", "personnage"], ["samourai", "personnage"], ["chevalier", "personnage"],
  ["sorcier", "personnage"], ["fee", "personnage"], ["robot", "personnage"],
  ["pecheur", "personnage"], ["voyageur", "personnage"], ["person", "personnage"],
  ["man", "personnage"], ["woman", "personnage"], ["girl", "personnage"], ["boy", "personnage"],
  ["visage", "visage"], ["portrait", "visage"], ["face", "visage"],
  ["lune", "astre"], ["moon", "astre"], ["soleil", "astre"], ["sun", "astre"],
  ["galaxie", "astre"], ["planete", "astre"], ["planet", "astre"], ["nebuleuse", "astre"],
  ["vaisseau", "vaisseau"], ["fusee", "vaisseau"], ["navette", "vaisseau"],
  ["rocket", "vaisseau"], ["spaceship", "vaisseau"],
  ["voiture", "voiture"], ["auto", "voiture"], ["car", "voiture"],
  ["velo", "velo"], ["bicyclette", "velo"], ["bike", "velo"],
  ["train", "train"], ["locomotive", "train"],
  ["montgolfiere", "montgolfiere"], ["dirigeable", "montgolfiere"],
  ["dragon", "dragon"],
  ["vache", "vache"], ["cow", "vache"],
  ["mouton", "mouton"], ["brebis", "mouton"], ["sheep", "mouton"],
  ["cheval", "cheval"], ["jument", "cheval"], ["horse", "cheval"],
  ["poisson", "poisson"], ["baleine", "poisson"], ["requin", "poisson"],
  ["dauphin", "poisson"], ["fish", "poisson"], ["whale", "poisson"],
];

const CADRES: ReadonlyArray<readonly [string, CadreScene]> = [
  ["mer", "ocean"], ["ocean", "ocean"], ["plage", "ocean"], ["littoral", "ocean"],
  ["cote", "ocean"], ["maritime", "ocean"], ["sable", "ocean"], ["marin", "ocean"],
  ["sea", "ocean"], ["beach", "ocean"], ["coast", "ocean"],
  ["montagne", "montagne"], ["sommet", "montagne"], ["alpin", "montagne"],
  ["pice", "montagne"], ["massif", "montagne"], ["mountain", "montagne"], ["alps", "montagne"],
  ["foret", "foret"], ["bois", "foret"], ["jungle", "foret"], ["sylve", "foret"],
  ["forest", "foret"], ["woods", "foret"],
  ["ville", "ville"], ["urbain", "ville"], ["cite", "ville"], ["rue", "ville"],
  ["gratte-ciel", "ville"], ["skyline", "ville"], ["metropole", "ville"],
  ["city", "ville"], ["urban", "ville"], ["street", "ville"],
  ["desert", "desert"], ["dune", "desert"], ["aride", "desert"], ["sahara", "desert"],
  ["oasis", "desert"], ["desert2", "desert"],
  ["campagne", "campagne"], ["champ", "campagne"], ["prairie", "campagne"],
  ["ferme", "campagne"], ["meuble", "campagne"], ["countryside", "campagne"],
  ["meadow", "campagne"], ["farm", "campagne"], ["field", "campagne"],
  ["lac", "lac"], ["etang", "lac"], ["riviere", "lac"], ["fleuve", "lac"],
  ["cascade", "lac"], ["lake", "lac"], ["river", "lac"], ["waterfall", "lac"],
  ["espace", "espace"], ["cosmos", "espace"], ["univers", "espace"],
  ["astronaute", "espace"], ["orbite", "espace"], ["space", "espace"], ["cosmic", "espace"],
];

const MOMENTS: ReadonlyArray<readonly [string, MomentScene]> = [
  ["aube", "aube"], ["aurore", "aube"], ["matinal", "aube"], ["dawn", "aube"], ["sunrise", "aube"],
  ["jour", "jour"], ["midi", "jour"], ["diurne", "jour"], ["day", "jour"], ["daytime", "jour"],
  ["crepuscule", "crepuscule"], ["couchant", "crepuscule"], ["crepusculaire", "crepuscule"],
  ["dusk", "crepuscule"], ["sunset", "crepuscule"], ["twilight", "crepuscule"],
  ["nuit", "nuit"], ["nocturne", "nuit"], ["minuit", "nuit"], ["etoile", "nuit"],
  ["night", "nuit"], ["midnight", "nuit"], ["starry", "nuit"],
  ["ensoleill", "jour"],
];

const METEOS: ReadonlyArray<readonly [string, MeteoScene]> = [
  ["nuage", "nuages"], ["nuageux", "nuages"], ["couvert", "nuages"],
  ["cloud", "nuages"], ["cloudy", "nuages"], ["overcast", "nuages"],
  ["pluie", "pluie"], ["pluvieux", "pluie"], ["averse", "pluie"], ["bruine", "pluie"],
  ["rain", "pluie"], ["rainy", "pluie"], ["drizzle", "pluie"],
  ["orage", "orage"], ["orageux", "orage"], ["tonnerre", "orage"], ["eclair", "orage"],
  ["foudre", "orage"], ["tempete", "orage"], ["storm", "orage"], ["thunder", "orage"], ["lightning", "orage"],
  ["neige", "neige"], ["neigeux", "neige"], ["hiver", "neige"], ["givre", "neige"],
  ["enneig", "neige"],
  ["snow", "neige"], ["snowy", "neige"], ["winter", "neige"],
  ["brouillard", "brouillard"], ["brume", "brouillard"], ["brumeux", "brouillard"],
  ["fog", "brouillard"], ["foggy", "brouillard"], ["mist", "brouillard"], ["misty", "brouillard"],
];

const STYLES: ReadonlyArray<readonly [string, StyleScene]> = [
  ["minimaliste", "minimal"], ["minimal", "minimal"], ["epure", "minimal"], ["flat", "minimal"],
  ["aquarelle", "aquarelle"], ["watercolor", "aquarelle"], ["aquarelle2", "aquarelle"],
  ["neon", "neon"], ["cyberpunk", "neon"], ["futuriste", "neon"], ["synthwave", "neon"],
  ["vaporwave", "neon"], ["laser", "neon"],
  ["cartoon", "bd"], ["comics", "bd"], ["manga", "bd"],
  ["vintage", "vintage"], ["retro", "vintage"], ["sepia", "vintage"],
  ["realiste", "gen3"], ["realisme", "gen3"], ["photorealiste", "gen3"], ["realistic", "gen3"],
];

const AMBIANCES: ReadonlyArray<readonly [string, AmbianceScene]> = [
  ["calme", "calme"], ["paisible", "calme"], ["serein", "calme"], ["sereine", "calme"],
  ["tranquille", "calme"], ["zen", "calme"], ["doux", "calme"], ["douce", "calme"],
  ["peaceful", "calme"], ["calm", "calme"],
  ["melancolique", "melancolique"], ["melancolie", "melancolique"], ["triste", "melancolique"],
  ["nostalgique", "melancolique"], ["sombre", "melancolique"],
  ["melancholic", "melancolique"], ["sad", "melancolique"],
  ["joyeux", "joyeux"], ["joyeuse", "joyeux"], ["heureux", "joyeux"], ["gai", "joyeux"],
  ["festif", "joyeux"], ["vif", "joyeux"], ["happy", "joyeux"], ["cheerful", "joyeux"],
  ["epique", "epique"], ["majestueux", "epique"], ["dramatique", "epique"],
  ["heroique", "epique"], ["grandiose", "epique"], ["epic", "epique"], ["majestic", "epique"],
  ["mysterieux", "mysterieux"], ["mystere", "mysterieux"], ["enigmatique", "mysterieux"],
  ["secret", "mysterieux"], ["mysterious", "mysterieux"], ["enigmatic", "mysterieux"],
];

const COULEURS: ReadonlyArray<readonly [string, string]> = [
  ["rouge", "rouge"], ["scarlet", "rouge"], ["orange", "orange"],
  ["jaune", "jaune"], ["yellow", "jaune"], ["vert", "vert"], ["green", "vert"],
  ["emeraude", "vert"], ["turquoise", "turquoise"], ["cyan", "turquoise"],
  ["bleu", "bleu"], ["blue", "bleu"], ["azur", "bleu"], ["indigo", "bleu"],
  ["violet", "violet"], ["purple", "violet"], ["pourpre", "violet"], ["mauve", "violet"],
  ["rose", "rose"], ["pink", "rose"],
  ["noir", "noir"], ["black", "noir"], ["blanc", "blanc"], ["white", "blanc"],
  ["gris", "gris"], ["gray", "gris"], ["grey", "gris"],
  ["dore", "dore"], ["doree", "dore"], ["golden", "dore"], ["gold", "dore"],
  ["argente", "argent"], ["silver", "argent"],
];

const SONS: ReadonlyArray<readonly [string, string]> = [
  ["vague", "vagues"], ["maree", "vagues"], ["wave", "vagues"],
  ["vent", "vent"], ["brise", "vent"], ["wind", "vent"], ["windy", "vent"],
  ["feu", "feu"], ["flamme", "feu"], ["cheminee", "feu"], ["brasier", "feu"], ["fire", "feu"],
  ["ruisseau", "ruisseau"], ["torrent", "ruisseau"], ["grotte", "ruisseau"],
  ["horloge", "horloge"], ["tictac", "horloge"], ["pendule", "horloge"], ["clock", "horloge"],
  ["cloche", "cloche"], ["carillon", "cloche"], ["bell", "cloche"],
  ["foule", "foule"], ["marche", "foule"], ["brouhaha", "foule"], ["crowd", "foule"],
  ["pas", "pas"], ["marche2", "pas"], ["footsteps", "pas"],
];

/* ------------------------------------------------------------------ */
/* Lexique intégré assemblé + index de correspondance                   */
/* ------------------------------------------------------------------ */

const ENTREES_INTEGREES: ReadonlyArray<EntreeIntegree> = [
  ...SUJETS.map(([stemme, valeur]) => ({ stemme, categorie: "sujet" as const, valeur })),
  ...CADRES.map(([stemme, valeur]) => ({ stemme, categorie: "cadre" as const, valeur })),
  ...MOMENTS.map(([stemme, valeur]) => ({ stemme, categorie: "moment" as const, valeur })),
  ...METEOS.map(([stemme, valeur]) => ({ stemme, categorie: "meteo" as const, valeur })),
  ...STYLES.map(([stemme, valeur]) => ({ stemme, categorie: "style" as const, valeur })),
  ...AMBIANCES.map(([stemme, valeur]) => ({ stemme, categorie: "ambiance" as const, valeur })),
  ...COULEURS.map(([stemme, valeur]) => ({ stemme, categorie: "couleur" as const, valeur })),
  ...SONS.map(([stemme, valeur]) => ({ stemme, categorie: "son" as const, valeur })),
];

/**
 * Index de correspondance : formes normalisées → (catégorie, valeur).
 * Construit UNE fois (lexique intégré) ou par fusion avec l'appris.
 */
export interface LexiqueMultimodal {
  /** Formes exactes (courtes, < 4 caractères ou stems tronqués). */
  exactes: Map<string, { categorie: CategorieLexique; valeur: string }>;
  /** Stems de préfixe (≥ 4 caractères) : token.startsWith(stemme). */
  prefixes: Map<string, { categorie: CategorieLexique; valeur: string }>;
}

/**
 * Normalise un mot : minuscule, sans accent, sans signe hors lettres.
 * (Les stems du lexique sont stockés sous cette forme canonique.)
 */
export function normaliserMot(mot: string): string {
  return mot
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z-]/g, "");
}

/** Construit l'index de correspondance depuis une liste d'entrées.
 *  Chaque stemme est indexé EXACT (prioritaire) et, s'il est long, en
 *  préfixe (repli pluriel/dérivés). */
function indexerEntrees(
  entrees: ReadonlyArray<EntreeIntegree>,
): LexiqueMultimodal {
  const exactes = new Map<string, { categorie: CategorieLexique; valeur: string }>();
  const prefixes = new Map<string, { categorie: CategorieLexique; valeur: string }>();
  for (const { stemme, categorie, valeur } of entrees) {
    // L'intégré PRIME sur l'appris : on n'écrase jamais une entrée existante.
    if (!exactes.has(stemme)) exactes.set(stemme, { categorie, valeur });
    if (stemme.length >= 4 && !stemme.includes("-") && !prefixes.has(stemme)) {
      prefixes.set(stemme, { categorie, valeur });
    }
  }
  return { exactes, prefixes };
}

const LEXIQUE_DEFAUT: LexiqueMultimodal = indexerEntrees(ENTREES_INTEGREES);

/* ------------------------------------------------------------------ */
/* Lexique APPRIS hors production (artefact multimodal-lexique)         */
/* ------------------------------------------------------------------ */

/** Une association apprise hors production (artefact committé). */
export interface EntreeApprise {
  /** Terme normalisé (comme produit par normaliserMot). */
  terme: string;
  categorie: CategorieLexique;
  /** Valeur typée de la catégorie (ex. SujetScene, CadreScene…). */
  valeur: string;
}

/** Artefact du pré-entraînement multimodal (scripts/pretrain-multimodal.ts). */
export interface LexiqueAppris {
  v: 1;
  entries: EntreeApprise[];
}

/**
 * Fusionne les entrées apprises avec l'intégré : seules les associations
 * ABSENTES du lexique intégré sont ajoutées (aucun conflit silencieux,
 * aucune écrasement du vocabulaire validé).
 */
export function construireLexique(appris?: LexiqueAppris | null): LexiqueMultimodal {
  if (!appris || !Array.isArray(appris.entries) || appris.entries.length === 0) {
    return LEXIQUE_DEFAUT;
  }
  const additionnelles: EntreeIntegree[] = [];
  for (const entree of appris.entries) {
    const terme = normaliserMot(String(entree.terme ?? ""));
    const valeur = String(entree.valeur ?? "");
    if (terme.length < 2 || valeur.length === 0) continue;
    additionnelles.push({ stemme: terme, categorie: entree.categorie, valeur });
  }
  return indexerEntrees([...ENTREES_INTEGREES, ...additionnelles]);
}

/* ------------------------------------------------------------------ */
/* ANALYSE                                                              */
/* ------------------------------------------------------------------ */

/** Découpe un prompt en tokens normalisés (mots porteurs de sens). */
function tokenizer(prompt: string): string[] {
  return prompt
    .split(/[\s,.:;!?'’()\-_/]+/)
    .map(normaliserMot)
    .filter((mot) => mot.length >= 2 && mot.length <= 24);
}

/** Retrouve la classification d'un token dans l'index : forme exacte
 *  d'abord, sinon LE PLUS LONG stemme de préfixe (« château » doit
 *  l'emporter sur « chat », « château » sur « chat »). */
function classifier(
  token: string,
  lexique: LexiqueMultimodal,
): { categorie: CategorieLexique; valeur: string; stemme: string } | null {
  const exacte = lexique.exactes.get(token);
  if (exacte) return { ...exacte, stemme: token };
  if (token.length >= 4) {
    let meilleur: { stemme: string; categorie: CategorieLexique; valeur: string } | null = null;
    for (const [stemme, entree] of lexique.prefixes) {
      if (token.startsWith(stemme) && (!meilleur || stemme.length > meilleur.stemme.length)) {
        meilleur = { stemme, ...entree };
      }
    }
    if (meilleur) return meilleur;
  }
  return null;
}

/**
 * CADRES IMPLICITES : certains sujets PORTENT leur environnement
 * (un phare se dresse sur la mer, une vache broute à la campagne).
 * Si le prompt ne nomme aucun cadre, le moteur de composition choisit
 * celui du sujet — décision de composition assumée, documentée dans
 * docs/multimodal/gen3-multimodal.md.
 */
const CADRES_IMPLICITES: Partial<Record<SujetScene, CadreScene>> = {
  phare: "ocean",
  voilier: "ocean",
  poisson: "ocean",
  vache: "campagne",
  mouton: "campagne",
};

/**
 * Analyse un prompt FR/EN et produit la spécification de scène.
 * DÉTERMINISTE : le même prompt produit toujours la même spécification.
 */
export function analyserScene(
  prompt: string,
  lexique: LexiqueMultimodal = LEXIQUE_DEFAUT,
): SceneSpec {
  const spec: SceneSpec = {
    sujet: null,
    cadre: null,
    moment: "jour",
    meteo: [],
    style: "gen3",
    ambiance: "calme",
    couleurPrincipale: null,
    sons: [],
    couverture: 0,
    motsReconnus: [],
  };

  const texte = prompt.toLowerCase();

  // 1. Locutions multi-mots résolues d'abord (priorité sémantique).
  const locutionsReconnues: string[] = [];
  for (const { phrase, categorie, valeur } of LOCUTIONS) {
    if (texte.includes(phrase)) {
      locutionsReconnues.push(phrase);
      appliquer(spec, categorie, valeur, phrase);
    }
  }

  // 2. Tokens un par un (ordre d'apparition = priorité).
  const tokens = tokenizer(prompt);
  let porteurs = 0;
  for (const token of tokens) {
    if (MOTS_VIDES.has(token)) continue;
    porteurs++;
    const classification = classifier(token, lexique);
    if (!classification) continue;
    appliquer(spec, classification.categorie, classification.valeur, token);
  }

  // 3. Couverture honnête : reconnus / mots porteurs de sens.
  const reconnus = spec.motsReconnus.length + locutionsReconnues.length;
  spec.couverture = porteurs > 0 ? Math.min(1, reconnus / porteurs) : 0;

  // 4. Cadre implicite du sujet (phare → mer, vache → campagne…) si
  //    le prompt n'en nomme aucun.
  if (!spec.cadre && spec.sujet) {
    spec.cadre = CADRES_IMPLICITES[spec.sujet.type] ?? null;
  }
  return spec;
}

/** Applique une classification à la spécification (un seul gagnant par axe). */
function appliquer(
  spec: SceneSpec,
  categorie: CategorieLexique,
  valeur: string,
  mot: string,
): void {
  switch (categorie) {
    case "sujet":
      if (!spec.sujet) {
        spec.sujet = { type: valeur as SujetScene, label: mot };
        spec.motsReconnus.push(mot);
      }
      break;
    case "cadre":
      if (!spec.cadre) {
        spec.cadre = valeur as CadreScene;
        spec.motsReconnus.push(mot);
      }
      break;
    case "moment":
      if (spec.moment === "jour") spec.moment = valeur as MomentScene;
      if (spec.motsReconnus.every((m) => m !== mot)) spec.motsReconnus.push(mot);
      break;
    case "meteo":
      if (!spec.meteo.includes(valeur as MeteoScene) && (valeur as MeteoScene) !== "clair") {
        spec.meteo.push(valeur as MeteoScene);
      }
      if (spec.motsReconnus.every((m) => m !== mot)) spec.motsReconnus.push(mot);
      break;
    case "style":
      if (spec.style === "gen3") spec.style = valeur as StyleScene;
      if (spec.motsReconnus.every((m) => m !== mot)) spec.motsReconnus.push(mot);
      break;
    case "ambiance":
      if (spec.ambiance === "calme") spec.ambiance = valeur as AmbianceScene;
      if (spec.motsReconnus.every((m) => m !== mot)) spec.motsReconnus.push(mot);
      break;
    case "couleur":
      if (!spec.couleurPrincipale) spec.couleurPrincipale = valeur;
      if (spec.motsReconnus.every((m) => m !== mot)) spec.motsReconnus.push(mot);
      break;
    case "son":
      if (!spec.sons.includes(valeur)) spec.sons.push(valeur);
      if (spec.motsReconnus.every((m) => m !== mot)) spec.motsReconnus.push(mot);
      break;
  }
}

/**
 * Le prompt décrit-il une scène rendable par les moteurs v2 ?
 * Critère HONNÊTE : au moins un sujet OU un cadre reconnu.
 */
export function sceneRendable(spec: SceneSpec): boolean {
  return spec.sujet !== null || spec.cadre !== null;
}

/**
 * Décompose un prompt en SEGMENTS de scènes (storyboard vidéo v2) :
 * chaque phrase / proposition devient une scène analysée. Maximum 4
 * scènes — au-delà, les segments excédentaires sont ignorés (durées
 * bornées). Si aucun séparateur, renvoie une seule scène.
 */
export function analyserScenesMultiples(
  prompt: string,
  lexique: LexiqueMultimodal = LEXIQUE_DEFAUT,
): SceneSpec[] {
  const segments = prompt
    .split(/[.!?;]+|,\s*(?:puis|ensuite|ensuite\s+que|après|apres|then|after)\s+/i)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 4)
    .slice(0, 4);
  if (segments.length === 0) return [analyserScene(prompt, lexique)];
  return segments.map((segment) => analyserScene(segment, lexique));
}

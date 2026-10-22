/**
 * ENTRAÎNEMENT HORS PRODUCTION DU LEXIQUE MULTIMODAL — module PUR.
 *
 * Gén3 génère texte / son / vidéo / image SANS GPU et sans IA externe.
 * La qualité de la génération scénique v2 dépend du VOCABULAIRE que
 * l'analyseur sémantique (scene-spec.ts) reconnaît. Ce module est
 * l'entraîneur qui élargit ce vocabulaire HORS PRODUCTION (sandbox /
 * CI — jamais sur le serveur de production) :
 *
 *  1. CORPUS D'AMORÇAGE : phrases bilingues annotées (classification
 *     attendue : sujet, cadre, moment, météo, style, ambiance,
 *     couleur, son) — matériau déterministe embarqué ;
 *  2. ENSEIGNEMENTS : associations (terme → valeur EXISTANTE d'une
 *     catégorie) ABSENTES du lexique intégré. Sécurité : aucun
 *     enseignement ne crée de nouveau type de SUJET (les sujets
 *     dessinables sont fixés par les moteurs de rendu) ni n'écrase
 *     le vocabulaire intégré ;
 *  3. ÉVALUATION HONNÊTE : la couverture des attendus est MESURÉE
 *     avant / après enrichissement, sur un jeu d'entraînement ET un
 *     jeu de test tenu à l'écart — une métrique n'est jamais
 *     inventée. Le rapport indique aussi ce qui RESTE non reconnu.
 *
 * Sortie : artefact `LexiqueAppris` committé dans
 * assets/neural-pretrained/ (cf. scripts/pretrain-multimodal.ts),
 * chargé au runtime par lexique-serveur.ts — la production ne
 * s'entraîne PAS, elle CHARGE le fruit de l'entraînement hors ligne.
 *
 * Module PUR — aucune dépendance Node, aucun appel réseau.
 */

import {
  analyserScene,
  construireLexique,
  normaliserMot,
  type CategorieLexique,
  type EntreeApprise,
  type LexiqueAppris,
} from "./scene-spec";

/* ------------------------------------------------------------------ */
/* Valeurs valides par catégorie (garde-fou des enseignements)          */
/* ------------------------------------------------------------------ */

export const VALEURS_VALIDES: Record<
  Exclude<CategorieLexique, "sujet">,
  ReadonlyArray<string>
> & { sujet: ReadonlyArray<string> } = {
  sujet: [
    "chat", "chien", "oiseau", "papillon", "arbre", "fleur", "phare", "voilier",
    "maison", "chateau", "pont", "tour", "personnage", "visage", "astre",
    "vaisseau", "voiture", "velo", "train", "montgolfiere", "dragon", "vache",
    "mouton", "cheval", "poisson",
  ],
  cadre: ["ocean", "montagne", "foret", "ville", "desert", "campagne", "lac", "espace"],
  moment: ["aube", "jour", "crepuscule", "nuit"],
  meteo: ["nuages", "pluie", "orage", "neige", "brouillard"],
  style: ["gen3", "minimal", "aquarelle", "neon", "bd", "vintage"],
  ambiance: ["calme", "melancolique", "joyeux", "epique", "mysterieux"],
  couleur: ["rouge", "orange", "jaune", "vert", "turquoise", "bleu", "violet", "rose", "noir", "blanc", "gris", "dore", "argent"],
  son: ["vagues", "vent", "feu", "ruisseau", "horloge", "cloche", "foule", "pas"],
};

/* ------------------------------------------------------------------ */
/* Corpus d'amorçage annoté (FR dominant + EN)                          */
/* ------------------------------------------------------------------ */

type Attendu = [CategorieLexique, string];

/** Une phrase du corpus + ce qu'un bon analyseur DOIT y reconnaître. */
export interface EntreeCorpus {
  phrase: string;
  attendus: Attendu[];
  /** Jeu de test (tenu à l'écart de l'enrichissement si true). */
  test?: boolean;
}

const c = (phrase: string, attendus: Attendu[], test = false): EntreeCorpus => ({
  phrase,
  attendus,
  test,
});

export const CORPUS_AMORCAGE: ReadonlyArray<EntreeCorpus> = [
  c("un chat noir au bord de la mer au coucher de soleil", [["sujet", "chat"], ["couleur", "noir"], ["cadre", "ocean"], ["moment", "crepuscule"]]),
  c("une forêt sous la pluie", [["cadre", "foret"], ["meteo", "pluie"]]),
  c("une ville la nuit sous la neige", [["cadre", "ville"], ["moment", "nuit"], ["meteo", "neige"]]),
  c("un phare dans la tempête au crépuscule", [["sujet", "phare"], ["meteo", "orage"], ["moment", "crepuscule"]]),
  c("un voilier sur l'océan par une journée ensoleillée", [["sujet", "voilier"], ["cadre", "ocean"], ["moment", "jour"]]),
  c("une montagne enneigée à l'aube", [["cadre", "montagne"], ["meteo", "neige"], ["moment", "aube"]]),
  c("un château au milieu du brouillard", [["sujet", "chateau"], ["meteo", "brouillard"]]),
  c("un portrait de femme aux cheveux dorés", [["sujet", "visage"], ["couleur", "dore"]]),
  c("un dragon majestueux au-dessus des nuages", [["sujet", "dragon"], ["ambiance", "epique"], ["meteo", "nuages"]]),
  c("un champ de fleurs au printemps dans la campagne", [["sujet", "fleur"], ["cadre", "campagne"]]),
  c("une galaxie spirale dans l'espace", [["sujet", "astre"], ["cadre", "espace"]]),
  c("une fusée qui décolle vers la lune", [["sujet", "vaisseau"]]),
  c("un cheval galopant dans la prairie au lever du soleil", [["sujet", "cheval"], ["cadre", "campagne"], ["moment", "aube"]]),
  c("une maison sous la neige en hiver", [["sujet", "maison"], ["meteo", "neige"]]),
  c("un pont au-dessus d'une rivière dans le brouillard", [["sujet", "pont"], ["cadre", "lac"], ["meteo", "brouillard"]]),
  c("une voiture rouge sur une route de désert", [["sujet", "voiture"], ["couleur", "rouge"], ["cadre", "desert"]]),
  c("un oiseau qui chante dans la forêt au petit matin", [["sujet", "oiseau"], ["cadre", "foret"], ["moment", "aube"]]),
  c("une plage tranquille avec du sable blanc", [["cadre", "ocean"], ["ambiance", "calme"], ["couleur", "blanc"]]),
  c("une rue de ville en aquarelle", [["cadre", "ville"], ["style", "aquarelle"]]),
  c("une ville futuriste néon la nuit", [["cadre", "ville"], ["style", "neon"], ["moment", "nuit"]]),
  c("un visage mélancolique en noir et blanc", [["sujet", "visage"], ["ambiance", "melancolique"], ["style", "vintage"]]),
  c("un arbre isolé dans la prairie au coucher du soleil", [["sujet", "arbre"], ["cadre", "campagne"], ["moment", "crepuscule"]], true),
  c("un poisson coloré dans la mer", [["sujet", "poisson"], ["cadre", "ocean"]]),
  c("une montgolfière dorée au-dessus des collines", [["sujet", "montgolfiere"], ["couleur", "dore"], ["cadre", "campagne"]]),
  c("un viking solitaire sur un rocher face à la mer", [["sujet", "personnage"], ["cadre", "ocean"], ["ambiance", "melancolique"]]),
  c("un train traversant une forêt d'automne", [["sujet", "train"], ["cadre", "foret"]]),
  c("une abbaye en ruine dans la brume", [["sujet", "chateau"], ["meteo", "brouillard"], ["ambiance", "mysterieux"]]),
  c("un chat endormi près de la cheminée", [["sujet", "chat"], ["son", "feu"]]),
  c("le tic-tac de l'horloge dans une pièce paisible", [["son", "horloge"], ["ambiance", "calme"]]),
  c("une cloche dans le brouillard du matin", [["son", "cloche"], ["meteo", "brouillard"], ["moment", "aube"]]),
  c("des pas dans une rue déserte la nuit", [["son", "pas"], ["cadre", "ville"], ["moment", "nuit"]], true),
  c("le brouhaha du marché sous un ciel couvert", [["son", "foule"], ["meteo", "nuages"]]),
  c("le bruit des vagues sur la plage au crépuscule", [["son", "vagues"], ["cadre", "ocean"], ["moment", "crepuscule"]]),
  c("le vent dans les arbres sur la montagne", [["son", "vent"], ["cadre", "montagne"]]),
  c("un ruisseau qui coule dans la forêt", [["son", "ruisseau"], ["cadre", "foret"]]),
  c("un mouton dans une prairie brumeuse", [["sujet", "mouton"], ["cadre", "campagne"], ["meteo", "brouillard"]]),
  c("une vache au champ sous un ciel azur", [["sujet", "vache"], ["cadre", "campagne"], ["couleur", "bleu"]]),
  c("un bateau de pêche rentrant au port au crépuscule", [["sujet", "voilier"], ["cadre", "ocean"], ["moment", "crepuscule"]]),
  c("une tour solitaire au milieu de la steppe", [["sujet", "tour"], ["cadre", "campagne"], ["ambiance", "melancolique"]]),
  c("un papillon sur une fleur turquoise", [["sujet", "papillon"], ["couleur", "turquoise"]]),
  c("a black cat by the sea at sunset", [["sujet", "chat"], ["couleur", "noir"], ["cadre", "ocean"], ["moment", "crepuscule"]]),
  c("a snowy mountain at dawn", [["cadre", "montagne"], ["meteo", "neige"], ["moment", "aube"]], true),
  c("a lighthouse in the storm", [["sujet", "phare"], ["meteo", "orage"]]),
  c("a neon city at night", [["cadre", "ville"], ["style", "neon"], ["moment", "nuit"]]),
  c("a sailboat on the ocean", [["sujet", "voilier"], ["cadre", "ocean"]]),
  c("a knight in a foggy castle", [["sujet", "personnage"], ["meteo", "brouillard"]]),
  c("a rocket flying to the moon", [["sujet", "vaisseau"]], true),
  c("a peaceful meadow with golden flowers", [["cadre", "campagne"], ["ambiance", "calme"], ["couleur", "dore"], ["sujet", "fleur"]]),
];

/* ------------------------------------------------------------------ */
/* ENSEIGNEMENTS — associations nouvelles (ABSENTES de l'intégré)        */
/* ------------------------------------------------------------------ */

/**
 * Associations apprises : termes nouveaux mappés sur des VALEURS
 * EXISTANTES (aucun nouveau type de sujet rendable n'est créé, aucun
 * conflit avec l'intégré — l'entraîneur les refuse sinon).
 */
export const ENSEIGNEMENTS: ReadonlyArray<EntreeApprise> = [
  // cadres supplémentaires → cadres rendables existants
  { terme: "baie", categorie: "cadre", valeur: "ocean" },
  { terme: "estuaire", categorie: "cadre", valeur: "ocean" },
  { terme: "falaise", categorie: "cadre", valeur: "ocean" },
  { terme: "ile", categorie: "cadre", valeur: "ocean" },
  { terme: "lagon", categorie: "cadre", valeur: "ocean" },
  { terme: "port", categorie: "cadre", valeur: "ocean" },
  { terme: "quai", categorie: "cadre", valeur: "ocean" },
  { terme: "fjord", categorie: "cadre", valeur: "montagne" },
  { terme: "crete", categorie: "cadre", valeur: "montagne" },
  { terme: "glacier", categorie: "cadre", valeur: "montagne" },
  { terme: "vallee", categorie: "cadre", valeur: "campagne" },
  { terme: "steppe", categorie: "cadre", valeur: "campagne" },
  { terme: "savane", categorie: "cadre", valeur: "campagne" },
  { terme: "toundra", categorie: "cadre", valeur: "campagne" },
  { terme: "banlieue", categorie: "cadre", valeur: "ville" },
  { terme: "quartier", categorie: "cadre", valeur: "ville" },
  { terme: "avenue", categorie: "cadre", valeur: "ville" },
  { terme: "boulevard", categorie: "cadre", valeur: "ville" },
  { terme: "sentier", categorie: "cadre", valeur: "foret" },
  { terme: "clairiere", categorie: "cadre", valeur: "foret" },
  { terme: "canyon", categorie: "cadre", valeur: "desert" },
  { terme: "wadi", categorie: "cadre", valeur: "desert" },
  { terme: "etang", categorie: "cadre", valeur: "lac" },
  // moments
  { terme: "soir", categorie: "moment", valeur: "crepuscule" },
  { terme: "soiree", categorie: "moment", valeur: "crepuscule" },
  { terme: "matin", categorie: "moment", valeur: "aube" },
  { terme: "apres-midi", categorie: "moment", valeur: "jour" },
  // météos
  { terme: "crachin", categorie: "meteo", valeur: "pluie" },
  { terme: "grele", categorie: "meteo", valeur: "pluie" },
  { terme: "verglas", categorie: "meteo", valeur: "neige" },
  { terme: "poudreuse", categorie: "meteo", valeur: "neige" },
  { terme: "blizzard", categorie: "meteo", valeur: "neige" },
  { terme: "vapeur", categorie: "meteo", valeur: "brouillard" },
  { terme: "eclaircies", categorie: "meteo", valeur: "nuages" },
  { terme: "bourrasque", categorie: "meteo", valeur: "orage" },
  // styles
  { terme: "pastel", categorie: "style", valeur: "aquarelle" },
  { terme: "huile", categorie: "style", valeur: "gen3" },
  { terme: "esquisse", categorie: "style", valeur: "minimal" },
  { terme: "vectoriel", categorie: "style", valeur: "minimal" },
  { terme: "graffiti", categorie: "style", valeur: "bd" },
  { terme: "pixel", categorie: "style", valeur: "bd" },
  { terme: "seventies", categorie: "style", valeur: "vintage" },
  { terme: "art-deco", categorie: "style", valeur: "vintage" },
  // ambiances
  { terme: "serenite", categorie: "ambiance", valeur: "calme" },
  { terme: "apaisant", categorie: "ambiance", valeur: "calme" },
  { terme: "relaxant", categorie: "ambiance", valeur: "calme" },
  { terme: "douceur", categorie: "ambiance", valeur: "calme" },
  { terme: "chagrin", categorie: "ambiance", valeur: "melancolique" },
  { terme: "solitude", categorie: "ambiance", valeur: "melancolique" },
  { terme: "regret", categorie: "ambiance", valeur: "melancolique" },
  { terme: "euphorie", categorie: "ambiance", valeur: "joyeux" },
  { terme: "celebration", categorie: "ambiance", valeur: "joyeux" },
  { terme: "exaltant", categorie: "ambiance", valeur: "joyeux" },
  { terme: "puissant", categorie: "ambiance", valeur: "epique" },
  { terme: "enigme", categorie: "ambiance", valeur: "mysterieux" },
  { terme: "cache", categorie: "ambiance", valeur: "mysterieux" },
  // couleurs
  { terme: "lime", categorie: "couleur", valeur: "vert" },
  { terme: "olive", categorie: "couleur", valeur: "vert" },
  { terme: "kaki", categorie: "couleur", valeur: "vert" },
  { terme: "marine", categorie: "couleur", valeur: "bleu" },
  { terme: "corail", categorie: "couleur", valeur: "rose" },
  { terme: "sang", categorie: "couleur", valeur: "rouge" },
  { terme: "lavande", categorie: "couleur", valeur: "violet" },
  { terme: "amethyste", categorie: "couleur", valeur: "violet" },
  { terme: "ivoire", categorie: "couleur", valeur: "blanc" },
  { terme: "charbon", categorie: "couleur", valeur: "noir" },
  { terme: "ebene", categorie: "couleur", valeur: "noir" },
  { terme: "cuivre", categorie: "couleur", valeur: "orange" },
  { terme: "brun", categorie: "couleur", valeur: "orange" },
  { terme: "marron", categorie: "couleur", valeur: "orange" },
  { terme: "beige", categorie: "couleur", valeur: "dore" },
  // sons
  { terme: "crepitement", categorie: "son", valeur: "feu" },
  { terme: "applaudissements", categorie: "son", valeur: "foule" },
  { terme: "conversation", categorie: "son", valeur: "foule" },
  { terme: "agitation", categorie: "son", valeur: "foule" },
  // sujets — synonymes mappés sur des types DÉJÀ rendables
  { terme: "minou", categorie: "sujet", valeur: "chat" },
  { terme: "matou", categorie: "sujet", valeur: "chat" },
  { terme: "toutou", categorie: "sujet", valeur: "chien" },
  { terme: "cabot", categorie: "sujet", valeur: "chien" },
  { terme: "mesange", categorie: "sujet", valeur: "oiseau" },
  { terme: "perroquet", categorie: "sujet", valeur: "oiseau" },
  { terme: "colombe", categorie: "sujet", valeur: "oiseau" },
  { terme: "pigeon", categorie: "sujet", valeur: "oiseau" },
  { terme: "canard", categorie: "sujet", valeur: "oiseau" },
  { terme: "cygne", categorie: "sujet", valeur: "oiseau" },
  { terme: "corneille", categorie: "sujet", valeur: "oiseau" },
  { terme: "tilleul", categorie: "sujet", valeur: "arbre" },
  { terme: "cedre", categorie: "sujet", valeur: "arbre" },
  { terme: "bouleau", categorie: "sujet", valeur: "arbre" },
  { terme: "pivoine", categorie: "sujet", valeur: "fleur" },
  { terme: "coquelicot", categorie: "sujet", valeur: "fleur" },
  { terme: "jonquille", categorie: "sujet", valeur: "fleur" },
  { terme: "chaumiere", categorie: "sujet", valeur: "maison" },
  { terme: "igloo", categorie: "sujet", valeur: "maison" },
  { terme: "grange", categorie: "sujet", valeur: "maison" },
  { terme: "donjon", categorie: "sujet", valeur: "chateau" },
  { terme: "palais", categorie: "sujet", valeur: "chateau" },
  { terme: "citadelle", categorie: "sujet", valeur: "chateau" },
  { terme: "viaduc", categorie: "sujet", valeur: "pont" },
  { terme: "passerelle", categorie: "sujet", valeur: "pont" },
  { terme: "minaret", categorie: "sujet", valeur: "tour" },
  { terme: "beffroi", categorie: "sujet", valeur: "tour" },
  { terme: "passant", categorie: "sujet", valeur: "personnage" },
  { terme: "randonneur", categorie: "sujet", valeur: "personnage" },
  { terme: "cuisinier", categorie: "sujet", valeur: "personnage" },
  { terme: "paysan", categorie: "sujet", valeur: "personnage" },
  { terme: "guerrier", categorie: "sujet", valeur: "personnage" },
  { terme: "archer", categorie: "sujet", valeur: "personnage" },
  { terme: "magicien", categorie: "sujet", valeur: "personnage" },
  { terme: "satellite", categorie: "sujet", valeur: "astre" },
  { terme: "comete", categorie: "sujet", valeur: "astre" },
  { terme: "soucoupe", categorie: "sujet", valeur: "vaisseau" },
  { terme: "astronef", categorie: "sujet", valeur: "vaisseau" },
  { terme: "camion", categorie: "sujet", valeur: "voiture" },
  { terme: "taxi", categorie: "sujet", valeur: "voiture" },
  { terme: "scooter", categorie: "sujet", valeur: "velo" },
  { terme: "trottinette", categorie: "sujet", valeur: "velo" },
  { terme: "wagon", categorie: "sujet", valeur: "train" },
  { terme: "tram", categorie: "sujet", valeur: "train" },
  { terme: "zeppelin", categorie: "sujet", valeur: "montgolfiere" },
  { terme: "hydre", categorie: "sujet", valeur: "dragon" },
  { terme: "wyvern", categorie: "sujet", valeur: "dragon" },
  { terme: "taureau", categorie: "sujet", valeur: "vache" },
  { terme: "boeuf", categorie: "sujet", valeur: "vache" },
  { terme: "agneau", categorie: "sujet", valeur: "mouton" },
  { terme: "chevre", categorie: "sujet", valeur: "mouton" },
  { terme: "poney", categorie: "sujet", valeur: "cheval" },
  { terme: "sardine", categorie: "sujet", valeur: "poisson" },
  { terme: "truite", categorie: "sujet", valeur: "poisson" },
  { terme: "carpe", categorie: "sujet", valeur: "poisson" },
  { terme: "saumon", categorie: "sujet", valeur: "poisson" },
  { terme: "thon", categorie: "sujet", valeur: "poisson" },
  { terme: "viking", categorie: "sujet", valeur: "personnage" },
  { terme: "knight", categorie: "sujet", valeur: "personnage" },
  { terme: "abbaye", categorie: "sujet", valeur: "chateau" },
  { terme: "colline", categorie: "cadre", valeur: "campagne" },
  { terme: "port", categorie: "cadre", valeur: "ocean" },
  { terme: "solitaire", categorie: "ambiance", valeur: "melancolique" },
  { terme: "ruine", categorie: "ambiance", valeur: "mysterieux" },
];

/* ------------------------------------------------------------------ */
/* Entraîneur                                                           */
/* ------------------------------------------------------------------ */

/** Mesure la part des attendus réellement reconnus sur le corpus. */
function evaluerCorpus(
  corpus: ReadonlyArray<EntreeCorpus>,
  lexique: ReturnType<typeof construireLexique>,
): { precision: number; unites: number; attendusTotal: number; attendusTrouves: number } {
  let attendusTotal = 0;
  let attendusTrouves = 0;
  let unites = 0;
  for (const entree of corpus) {
    const spec = analyserScene(entree.phrase, lexique);
    let trouvesIci = 0;
    for (const [categorie, valeur] of entree.attendus) {
      attendusTotal++;
      if (attenduTrouve(spec, categorie, valeur)) trouvesIci++;
    }
    if (trouvesIci === entree.attendus.length) unites++;
    attendusTrouves += trouvesIci;
  }
  return {
    precision: attendusTotal > 0 ? attendusTrouves / attendusTotal : 0,
    unites,
    attendusTotal,
    attendusTrouves,
  };
}

/** Vérifie qu'une classification attendue figure dans la spécification. */
function attenduTrouve(
  spec: ReturnType<typeof analyserScene>,
  categorie: CategorieLexique,
  valeur: string,
): boolean {
  switch (categorie) {
    case "sujet":
      return spec.sujet?.type === valeur;
    case "cadre":
      return spec.cadre === valeur;
    case "moment":
      return spec.moment === valeur;
    case "meteo":
      return spec.meteo.includes(valeur as never);
    case "style":
      return spec.style === valeur;
    case "ambiance":
      return spec.ambiance === valeur;
    case "couleur":
      return spec.couleurPrincipale === valeur;
    case "son":
      return spec.sons.includes(valeur);
  }
}

export interface ResultatEntrainementLexique {
  /** Artefact à committer (assets/neural-pretrained/). */
  appris: LexiqueAppris;
  rapport: {
    entrainements: number;
    enseignementsRefuses: number;
    raisonsRefus: string[];
    avant: { precisionTrain: number; precisionTest: number };
    apres: { precisionTrain: number; precisionTest: number; precisionGlobale: number };
    corpusTaille: number;
    environnement: string;
  };
}

/**
 * Entraîne le lexique : valide les enseignements, mesure avant/après.
 * Déterministe et pur — le script hors production l'appelle et écrit
 * l'artefact ; les tests l'appellent directement.
 */
export function entrainerLexiqueMultimodal(
  options: { environnement?: string } = {},
): ResultatEntrainementLexique {
  const debut = Date.now();
  void debut;
  const integre = construireLexique(null);

  // 1. Évaluation AVANT enrichissement.
  const corpusTrain = CORPUS_AMORCAGE.filter((e) => !e.test);
  const corpusTest = CORPUS_AMORCAGE.filter((e) => e.test);
  const avantTrain = evaluerCorpus(corpusTrain, integre);
  const avantTest = evaluerCorpus(corpusTest, integre);

  // 2. Validation des enseignements (aucun conflit avec l'intégré,
  //    valeurs strictement valides, aucun nouveau type de sujet hors
  //    liste rendable).
  const refuse: string[] = [];
  const valides: EntreeApprise[] = [];
  for (const enseignement of ENSEIGNEMENTS) {
    const terme = normaliserMot(enseignement.terme);
    const valeurs = VALEURS_VALIDES[enseignement.categorie];
    if (!terme || terme.length < 2) {
      refuse.push(`terme invalide : « ${enseignement.terme} »`);
      continue;
    }
    if (!valeurs.includes(enseignement.valeur)) {
      refuse.push(`valeur inconnue : « ${enseignement.valeur} » (${enseignement.categorie})`);
      continue;
    }
    // L'intégré prime : un terme déjà couvert n'est pas réappris
    // (extension du stemme par le terme — jamais l'inverse).
    const dejaCouvert =
      integre.exactes.has(terme) ||
      Array.from(integre.prefixes.keys()).some((p) => terme.startsWith(p));
    if (dejaCouvert) {
      refuse.push(`déjà couvert par l'intégré : « ${terme} »`);
      continue;
    }
    if (valides.some((v) => v.terme === terme && v.categorie === enseignement.categorie)) {
      refuse.push(`doublon d'enseignement : « ${terme} » (${enseignement.categorie})`);
      continue;
    }
    valides.push({ terme, categorie: enseignement.categorie, valeur: enseignement.valeur });
  }

  const appris: LexiqueAppris = { v: 1, entries: valides };
  const enrichi = construireLexique(appris);

  // 3. Évaluation APRÈS (même corpus, même métrique).
  const apresTrain = evaluerCorpus(corpusTrain, enrichi);
  const apresTest = evaluerCorpus(corpusTest, enrichi);
  const apresGlobal = evaluerCorpus(CORPUS_AMORCAGE, enrichi);

  return {
    appris,
    rapport: {
      entrainements: valides.length,
      enseignementsRefuses: refuse.length,
      raisonsRefus: refuse.slice(0, 20),
      avant: {
        precisionTrain: Number(avantTrain.precision.toFixed(4)),
        precisionTest: Number(avantTest.precision.toFixed(4)),
      },
      apres: {
        precisionTrain: Number(apresTrain.precision.toFixed(4)),
        precisionTest: Number(apresTest.precision.toFixed(4)),
        precisionGlobale: Number(apresGlobal.precision.toFixed(4)),
      },
      corpusTaille: CORPUS_AMORCAGE.length,
      environnement: options.environnement ?? "pré-entraînement multimodal HORS PRODUCTION (sandbox de développement)",
    },
  };
}

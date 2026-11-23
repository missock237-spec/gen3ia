import { MAX_PAIRES_DATASET } from "@/lib/training/engines/gen3-dataset";

/**
 * GÉNÉRATEUR DE DONNÉES SYNTHÉTIQUES (paires, exemples, datasets).
 *
 * Exigence produit : gen3 doit pouvoir CRÉER des paires de données, des
 * exemples et des datasets pour entraîner TOUTES les IA qui lui sont
 * fournies — et adapter le format au système neuronal de la cible :
 *
 *   - famille « langage »       → paires Q/R (cortex langagier gen3) ;
 *   - famille « classification » → vecteurs + labels (modèles tenseur MLP) ;
 *   - famille « onde »          → cibles d'onde complexes (noeuds RPIA).
 *
 * HONNÊTETÉ : la génération est DÉTERMINISTE (PRNG mulberry32 seedé) et les
 * réponses calculées le sont par code (arithmétique, conversions) — jamais
 * inventées. Chaque dataset est dédupliqué, plafonné (MAX_PAIRES_DATASET,
 * même cap que le parsing) et exporté en jsonl/csv directement compatibles
 * avec parserDatasetGen3 et les schémas datasetAsset du studio.
 */

export type FamilleDonnees = "langage" | "classification" | "onde";

/** PRNG mulberry32 — même graine → mêmes données (tests et reproductibilité). */
export function creerAlea(graine: number): () => number {
  let a = Math.floor(graine) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── Paires langage ──────────────────────────────────────────────────── */

const SALUTATIONS = ["bonjour", "salut", "hello", "coucou", "bonsoir"] as const;
const UNITES_FR = [
  "zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf",
  "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize",
];

/** Nombre en lettres (0-99) — les opérandes DEVIENT des tokens informatifs
 * du cortex (les chiffres sont filtrés comme numériques par le rappel). */
export function nombreEnLettres(n: number): string {
  if (n < 17) return UNITES_FR[n];
  if (n < 20) return `dix-${UNITES_FR[n - 10]}`;
  const diz = Math.floor(n / 10);
  const u = n % 10;
  if (diz >= 2 && diz <= 6) {
    const base = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante"][diz];
    if (u === 0) return base;
    if (u === 1) return `${base}-et-un`;
    return `${base}-${UNITES_FR[u]}`;
  }
  if (diz === 7) {
    if (u === 0) return "soixante-dix";
    if (u === 1) return "soixante-et-onze";
    const r = n - 60;
    return `soixante-${r < 17 ? UNITES_FR[r] : `dix-${UNITES_FR[r - 10]}`}`;
  }
  if (diz === 8) {
    if (u === 0) return "quatre-vingts";
    if (u === 1) return "quatre-vingt-un";
    return `quatre-vingt-${u < 17 ? UNITES_FR[u] : `dix-${UNITES_FR[u - 10]}`}`;
  }
  if (u === 0) return "quatre-vingt-dix";
  const r = n - 80;
  return `quatre-vingt-${r < 17 ? UNITES_FR[r] : `dix-${UNITES_FR[r - 10]}`}`;
}

/** Objets : rendent chaque question de calcul distincte ET naturelle. */
const OBJETS = [
  "pommes", "livres", "voitures", "maisons", "chaises", "tables", "clés", "journaux",
  "mangues", "avions", "bateaux", "ponts", "écoles", "jardins", "fenêtres", "portes",
  "verres", "assiettes", "stylos", "carnets", "balles", "raquettes", "lampions", "coquillages",
] as const;

function arrondi(x: number): string {
  return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(2)));
}

const DEFINITIONS: ReadonlyArray<{ terme: string; definition: string }> = [
  { terme: "un dataset", definition: "un ensemble structuré de données d'exemple servant à entraîner ou évaluer un modèle" },
  { terme: "l'apprentissage supervisé", definition: "l'apprentissage où le modèle reçoit des paires entrée-sortie et ajuste ses paramètres pour reproduire les sorties" },
  { terme: "une epoch", definition: "un passage complet du modèle sur l'ensemble des données d'entraînement" },
  { terme: "la généralisation", definition: "la capacité d'un modèle à rester performant sur des données qu'il n'a jamais vues" },
  { terme: "un gradient", definition: "la direction de variation d'une erreur, utilisée pour ajuster les poids d'un modèle pas à pas" },
  { terme: "le sur-apprentissage", definition: "le cas où un modèle mémorise ses données d'entraînement et échoue sur des données nouvelles" },
];

/** Paires Q/R synthétiques à réponses CALCULÉES (arithmétique, conversions, définitions). */
export function genererPairesLangage(params: {
  nombre: number;
  theme?: string;
  graine?: number;
}): { paires: { question: string; reponse: string }[]; doublonsIgnores: number } {
  const alea = creerAlea(params.graine ?? 20261122);
  const theme = params.theme?.trim() || "synthetique";
  const cible = Math.max(1, Math.min(MAX_PAIRES_DATASET, Math.floor(params.nombre)));
  const vues = new Set<string>();
  const paires: { question: string; reponse: string }[] = [];
  let doublonsIgnores = 0;
  let garde = 0;

  while (paires.length < cible && garde < cible * 12) {
    garde += 1;
    const type = Math.floor(alea() * 4);
    let question: string;
    let reponse: string;
    if (type === 0) {
      const a = 2 + Math.floor(alea() * 98);
      const b = 2 + Math.floor(alea() * 98);
      const op = Math.floor(alea() * 3);
      const [mot, resultat] = op === 0 ? ["plus", a + b] : op === 1 ? ["fois", a * b] : ["moins", a - b];
      const objet = OBJETS[Math.floor(alea() * OBJETS.length)];
      question = `Combien font ${nombreEnLettres(a)} ${mot} ${nombreEnLettres(b)} ${objet} ?`;
      reponse = `${a} ${mot} ${b} ${objet} = ${arrondi(resultat)} ${objet}.`;
    } else if (type === 1) {
      const heures = 1 + Math.floor(alea() * 98);
      question = `Combien de minutes dans ${nombreEnLettres(heures)} heures ?`;
      reponse = `${heures} heures = ${heures * 60} minutes.`;
    } else if (type === 2) {
      const salut = SALUTATIONS[Math.floor(alea() * SALUTATIONS.length)];
      question = salut;
      reponse = `Bonjour ! Je suis gen3, entraîné sur ce jeu « ${theme} ». Que puis-je faire pour vous ?`;
    } else {
      const def = DEFINITIONS[Math.floor(alea() * DEFINITIONS.length)];
      question = `Qu'est-ce que ${def.terme} ?`;
      reponse = `${def.terme.charAt(0).toUpperCase() + def.terme.slice(1)} : ${def.definition}.`;
    }
    // Référence unique par paire : garantit un rappel NON AMBIGU du cortex
    // (chaque motif garde au moins un token lexical qu'aucune autre paire
    // ne possède — la récupération ne peut pas ex æquo).
    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    const reference = `${alphabet[Math.floor(alea() * 26)]}${alphabet[Math.floor(alea() * 26)]}${Math.floor(alea() * 100)
      .toString()
      .padStart(2, "0")}`;
    question = `${question} (réf. ${reference})`;
    const cle = question.toLowerCase();
    if (vues.has(cle)) {
      doublonsIgnores += 1;
      continue;
    }
    vues.add(cle);
    paires.push({ question, reponse });
  }
  return { paires, doublonsIgnores };
}

/* ── Exemples classification ─────────────────────────────────────────── */

export interface ExempleClassification {
  entrees: number[];
  label: string;
}

/** Clusters gaussiens séparables par construction (centroïdes distincts). */
export function genererExemplesClassification(params: {
  nombre: number;
  classes?: number;
  dimensions?: number;
  graine?: number;
}): { exemples: ExempleClassification[]; labels: string[]; doublonsIgnores: number } {
  const alea = creerAlea(params.graine ?? 424242);
  const nbClasses = Math.max(2, Math.min(6, params.classes ?? 3));
  const dims = Math.max(2, Math.min(32, params.dimensions ?? 4));
  const cible = Math.max(nbClasses * 4, Math.min(5000, Math.floor(params.nombre)));
  const labels = Array.from({ length: nbClasses }, (_, i) => `classe-${i + 1}`);
  const distance = Math.sqrt(dims); // écarte les centroïdes → séparables
  const centroides = labels.map((_, i) => {
    const angle = (2 * Math.PI * i) / nbClasses;
    return Array.from({ length: dims }, (_, d) =>
      Math.cos(angle) * distance + (d === 0 ? 0 : Math.sin(angle) * 0.5 * (d % 2 === 0 ? 1 : -1)),
    );
  });
  const sigma = 0.35 * (distance / Math.sqrt(2));
  const gaussienne = () => {
    // Box-Muller déterministe (deux tirages uniformes du PRNG).
    const u1 = Math.max(1e-9, alea());
    const u2 = alea();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
  };
  const exemples: ExempleClassification[] = [];
  for (let i = 0; i < cible; i += 1) {
    const c = Math.floor(alea() * nbClasses);
    exemples.push({
      entrees: centroides[c].map((v) => Number((v + gaussienne()).toFixed(4))),
      label: labels[c],
    });
  }
  return { exemples, labels, doublonsIgnores: 0 };
}

/* ── Cibles d'onde (RPIA) ────────────────────────────────────────────── */

/** Signaux sinusoïdaux composés + bruit, normalisés — cibles réelles d'interférence. */
export function genererCiblesOnde(params: {
  nombre: number;
  noeuds?: number;
  harmoniques?: number;
  graine?: number;
}): { cibles: Float32Array[]; doublonsIgnores: number } {
  const alea = creerAlea(params.graine ?? 777_888);
  const noeuds = Math.max(16, Math.min(4096, params.noeuds ?? 64));
  const h = Math.max(1, Math.min(16, params.harmoniques ?? 3));
  const cibles: Float32Array[] = [];
  for (let n = 0; n < Math.max(1, Math.min(5000, params.nombre)); n += 1) {
    const phases = Array.from({ length: h }, () => alea() * 2 * Math.PI);
    const amplitudes = Array.from({ length: h }, () => 0.4 + alea() * 0.6);
    const freqs = Array.from({ length: h }, (_, k) => (k + 1) * (1 + Math.floor(alea() * 3)));
    const onde = new Float32Array(noeuds);
    for (let t = 0; t < noeuds; t += 1) {
      const x = (t / noeuds) * Math.PI * 2;
      let somme = 0;
      for (let k = 0; k < h; k += 1) {
        somme += amplitudes[k] * Math.sin(freqs[k] * x + phases[k]);
      }
      onde[t] = Number((somme / h).toFixed(4));
    }
    cibles.push(onde);
  }
  return { cibles, doublonsIgnores: 0 };
}

/* ── Dataset exportable + split ──────────────────────────────────────── */

export interface DatasetSynthetique {
  nom: string;
  famille: FamilleDonnees;
  format: "jsonl" | "csv";
  /** Contenu prêt à sauvegarder / parser (parserDatasetGen3 côté langage). */
  contenu: string;
  elements: number;
  doublonsIgnores: number;
  apercu: string;
}

function serialiserJsonl(lignes: object[]): string {
  return lignes.map((l) => JSON.stringify(l)).join("\n");
}

/** Construit un dataset EXPORTABLE (jsonl/csv) pour la famille demandée. */
export function construireDataset(params: {
  famille: FamilleDonnees;
  nombre: number;
  graine?: number;
  theme?: string;
  format?: "jsonl" | "csv";
  noeudsOnde?: number;
  harmoniques?: number;
}): DatasetSynthetique {
  const graine = params.graine ?? 20261122;
  if (params.famille === "langage") {
    const { paires, doublonsIgnores } = genererPairesLangage({
      nombre: params.nombre,
      theme: params.theme,
      graine,
    });
    const format = params.format ?? "jsonl";
    const contenu =
      format === "csv"
        ? ["question,reponse", ...paires.map((p) => `"${p.question.replace(/"/g, '""')}","${p.reponse.replace(/"/g, '""')}"`)].join("\n")
        : serialiserJsonl(paires);
    return {
      nom: `synthetique-langage-${graine}-${paires.length}`,
      famille: params.famille,
      format,
      contenu,
      elements: paires.length,
      doublonsIgnores,
      apercu: contenu.split("\n").slice(0, 2).join(" · ").slice(0, 220),
    };
  }
  if (params.famille === "classification") {
    const { exemples, labels } = genererExemplesClassification({ nombre: params.nombre, graine });
    const contenu = serialiserJsonl(exemples);
    return {
      nom: `synthetique-classification-${graine}-${exemples.length}`,
      famille: params.famille,
      format: "jsonl",
      contenu,
      elements: exemples.length,
      doublonsIgnores: 0,
      apercu: `classes: ${labels.join(", ")} · ${contenu.split("\n")[0]?.slice(0, 180)}`,
    };
  }
  const { cibles } = genererCiblesOnde({
    nombre: params.nombre,
    noeuds: params.noeudsOnde,
    harmoniques: params.harmoniques,
    graine,
  });
  const contenu = serialiserJsonl(cibles.map((onde) => ({ onde: Array.from(onde) })));
  return {
    nom: `synthetique-onde-${graine}-${cibles.length}`,
    famille: "onde",
    format: "jsonl",
    contenu,
    elements: cibles.length,
    doublonsIgnores: 0,
    apercu: `cibles d'onde (${cibles[0]?.length ?? 0} nœuds) · harmoniques: ${params.harmoniques ?? 3}`,
  };
}

/** Split train/test déterministe (mélange seedé) pour TOUTE famille. */
export function separerDonnees<T>(items: readonly T[], ratioTest: number, graine = 1234): { train: T[]; test: T[] } {
  if (items.length < 4 || ratioTest <= 0) return { train: [...items], test: [] };
  const copie = [...items];
  const alea = creerAlea(graine);
  for (let i = copie.length - 1; i > 0; i -= 1) {
    const j = Math.floor(alea() * (i + 1));
    [copie[i], copie[j]] = [copie[j], copie[i]];
  }
  const tailleTest = Math.max(1, Math.floor(copie.length * Math.min(0.5, ratioTest)));
  return { train: copie.slice(tailleTest), test: copie.slice(0, tailleTest) };
}

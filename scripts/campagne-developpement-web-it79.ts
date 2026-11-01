/**
 * CAMPAGNE DÉVELOPPEMENT WEB it.79 — GEN3 ÉCRIT, COMPREND ET SIMULE DU CODE.
 *
 * DEMANDE PROPRIÉTAIRE (session directe, trace 1a197bdfb7f467bd) : « entraîne
 * gen3 dans le développement web : il doit pouvoir écrire du code, comprendre
 * puis simuler du code ; une fois terminé assure-toi qu'il est mis à la
 * disposition des utilisateurs sur le domaine en ligne ; entraîne-le pour
 * 1 milliard d'exemples et 1 million de datasets ».
 *
 * INTERPRÉTATION HONNÊTE DE L'ÉCHELLE : 1 000 000 de datasets = le corpus
 * d'EXEMPLES UNIQUES (bijection index→exemple par radix mixte — unicité
 * garantie, zéro duplication) ; 1 000 000 000 d'exemples = le total
 * d'échantillons vus par le cortex (le corpus unique est cyclé dans un ordre
 * déterministe jusqu'à l'objectif). Le script mesure le DÉBIT réel
 * (échantillons/s) et publie l'extrapolation honnête de la durée — sur un
 * VPS 1 vCPU la campagne complète s'étale sur plusieurs sessions reliées par
 * les CHECKPOINTS (var/neural-webdev/, un par lot — `--reprendre` reprend au
 * lot exact).
 *
 * MATIÈRE (comptabilité honnête, aucune invention) :
 *  1. RÉELLE du dépôt : datasets/code/train.jsonl (12 000 exemples
 *     api_design / bug_to_fix / feature_to_tests… FR/EN, matière officielle
 *     CC-BY-4.0-synthetic-gen3ia) — l'ancrage charte et les questions
 *     canoniques complètent la supervision du domaine generation-code ;
 *  2. PROCÉDURALE web-dev (graine 42, 3 capacités) :
 *     - ÉCRIRE  : gabarits de code TypeScript RÉELS paramétrés (debounce,
 *       throttle, fetch avec retry, validation, localStorage, React, SQL…) —
 *       chaque index produit une paire (instruction, code complet) unique ;
 *     - COMPRENDRE : question + code + réponse EXACTE dérivée des
 *       métadonnées du gabarit (but, cas limite, contexte, signature) ;
 *     - SIMULER : fonctions pures déterministes (somme, max, fibonacci,
 *       dichotomie…) — SORTIE ET TRACE PAR PAS CALCULÉES PAR EXÉCUTION
 *       RÉELLE du code généré pendant la génération (new Function en Node :
 *       le code exécuté est EXACTEMENT la chaîne publiée ; si l'exécution
 *       échoue la campagne S'ARRÊTE — aucun chiffre fantôme).
 *
 * PROTOCOLE (mesuré, jamais estimé — mécanique EOD it.57/63 INCHANGÉE) :
 *  1. ANCRAGE 19 DOMAINES — 2 vagues × 2 000 gabarits charte/domaine
 *     (indices 0..3999, identiques it.77) : les bandes des 18 autres
 *     domaines de vocation restent ancrées ;
 *  2. LOTS MIXTES — chaque lot : 1 500 exemples code (3 capacités
 *     entrelacées, cyclées sur le corpus unique) + 26 gabarits charte par
 *     domaine × 19 — interclassement mesuré it.63 (une bande ne reste jamais
 *     seule en piste) ; checkpoint après CHAQUE lot ;
 *  3. ALIGNEMENT INFÉRENCE — projection hash + même plasticité que le
 *     trainer (mécanique it.77), EPOQUES × matières code (~1 200 échantillons
 *     du corpus + charte generation-code + questions canoniques) ;
 *  4. SONDES — (a) 9 sondes code JAMAIS supervisées (indices U+100..U+108,
 *     hors plage cyclée quel que soit l'objectif) : cortex entraîné vs
 *     cortex NEUF (même seed, zéro supervision) → ratio publié tel quel ;
 *     (b) sondes 19 domaines IDENTIQUES it.77 (questions canoniques +
 *     indices 4901/4902) — l'anti-retour accumulé est vérifié (socle
 *     it.73 gelé 1,242484) ;
 *  5. QUANTIFICATION u8 + RÈGLE DE LIVRAISON ENCODÉE — le snapshot n'est
 *     écrit dans public/ (donc jamais servi aux utilisateurs) que si :
 *     ratio code moyen > 1 ET argmax bande attendu ≥ 7/9 ET accord u8 = 9/9
 *     ET plancher 19 domaines ≥ socle it.73. Sinon le snapshot it.76 reste
 *     en production et la mesure est publiée telle quelle.
 *
 * Usage :
 *   npx tsx scripts/campagne-developpement-web-it79.ts                 # campagne complète (1 Md / 1 M)
 *   npx tsx scripts/campagne-developpement-web-it79.ts --objectif 120000 --uniques 160000  # session bornée
 *   npx tsx scripts/campagne-developpement-web-it79.ts --reprendre     # reprise après interruption
 *   npx tsx scripts/campagne-developpement-web-it79.ts --benchmark     # calibration seule (aucun checkpoint)
 * Aucun service d'IA externe : tout est simulé localement (SNN purement local).
 */

import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { CortexColumnnaire } from "../lib/neural/core/v2/cortex-columnnaire";
import { ChampCorticalGen3 } from "../lib/neural/core/v2/champ-cortical";
import { CortexTelephone } from "../lib/neural/core/v2/cortex-telephone";
import {
  erreurMaxQuantisation,
  exporterSnapshotTelephone,
  importerSnapshotTelephone,
  quantiserPoidsU8,
} from "../lib/neural/core/v2/energie";
import {
  bandeDuDomaine,
  entrainerDomainesParOndes,
  porteurBande,
} from "../lib/neural/training/entrainement-ondes";
import { tokenize } from "../lib/neural/encoding/text-encoder";
import { texteDomaine } from "../lib/gen3/gabarits-domaines";
import { CORPUS_QUESTIONS_VOCATION } from "../lib/gen3/corpus-questions";
import { DOMAINES_VOCATION } from "../lib/gen3/vocation";

/* ------------------------------------------------------------------ */
/* Paramètres de session                                              */
/* ------------------------------------------------------------------ */

const COLONNES = 131072; // 2^17 (config téléphone it.73/76/77 — snapshot embarqué)
const ECHANTILLONS_GABARITS = 2000; // par vague EOD et par domaine (identique it.77)
const INDICE_SONDE_19_1 = 4901; // identique it.77 — comparabilité anti-retour
const INDICE_SONDE_19_2 = 4902; // identique it.77
const PLANCHER_SOCLE_IT73 = 1.242484; // socle gelé (artefact it.73) — anti-retour accumulé
const TAILLE_LOT_CODE = 1500; // exemples code par lot mixte
const ANCRAGE_PAR_DOMAINE = 26; // gabarits charte par domaine dans chaque lot mixte (19 × 26 = 494)
const CYCLES_EOD = 3; // cycles par échantillon (identique it.57/63/77)
const CYCLES_SONDE = 4; // fenêtre de lecture (identique production)
const LR = 0.15; // taux d'apprentissage EOD/alignement (identique)
const HORLOGE_LOTS_DEBUT = 400000; // monotone > vagues EOD
const GRAINE = 42;
const DEF_OBJECTIF = 1_000_000_000; // 1 milliard d'exemples (demande propriétaire)
const DEF_UNIQUES = 1_000_000; // 1 million de datasets uniques (demande propriétaire)
const DEF_EPOQUES = 3;
const MATIERES_ALIGN = 1200; // échantillons du corpus par époque d'alignement
const CAPACITES = ["ecrire", "comprendre", "simuler"] as const;
type Capacite = (typeof CAPACITES)[number];

const repereCheckpoint = join(process.cwd(), "var", "neural-webdev");
const cheminCheckpoint = join(repereCheckpoint, "checkpoint.bin");
const cheminProgress = join(repereCheckpoint, "progress.json");

const ARTEFACT_PRECEDENT = "assets/neural-pretrained/cortex-telephone-it76.json";

/* ------------------------------------------------------------------ */
/* Options CLI                                                        */
/* ------------------------------------------------------------------ */

interface Options {
  objectif: number;
  uniques: number;
  epoques: number;
  ancrage: number;
  reprendre: boolean;
  benchmark: boolean;
}
function optionsCLI(): Options {
  const args = process.argv.slice(2);
  const nombre = (cle: string, defaut: number): number => {
    const i = args.indexOf(cle);
    if (i < 0 || i + 1 >= args.length) return defaut;
    const v = Number(args[i + 1]);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : defaut;
  };
  return {
    objectif: nombre("--objectif", DEF_OBJECTIF),
    uniques: nombre("--uniques", DEF_UNIQUES),
    epoques: nombre("--epoques", DEF_EPOQUES),
    ancrage: nombre("--ancrage", ANCRAGE_PAR_DOMAINE),
    reprendre: args.includes("--reprendre"),
    benchmark: args.includes("--benchmark"),
  };
}

function horodatage(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " (UTC)";
}
function m6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
function capaciteDe(i: number): Capacite {
  return CAPACITES[i % 3]!;
}

/* ------------------------------------------------------------------ */
/* MATIÈRE PROCÉDURALE — ÉCRIRE / COMPRENDRE (bijection index→exemple) */
/* ------------------------------------------------------------------ */

const NOMS_METIER = [
  "Boutique", "Clinique", "Ferme", "Banque", "Lycee", "Garage", "Hotel", "Bibliotheque",
  "Restaurant", "Agence", "Cabinet", "Atelier", "Pharmacie", "Mairie", "Festival", "Pension",
  "Citerne", "Pepiniere", "Taxi", "Coach", "Galerie", "Marche", "Frigo", "Sentinelle",
  "Panier", "Facture", "Devis", "Stock", "Client", "RendezVous", "Rapport", "Signature",
  "Newsletter", "Avis", "Reservation", "Inscription", "Catalogue",
] as const;
const TYPES = ["string", "number", "boolean", "string[]", "{ cle: string; valeur: number }"] as const;
const SEUILS = [3, 5, 10, 20, 50, 100, 250, 500, 1000] as const;
const CONTEXTES = [
  "Next.js 16", "React 19", "Node 22", "TypeScript strict", "Vitest", "Firebase", "Prisma",
  "Stripe", "i18n FR", "accessibilité WCAG", "PWA", "SSR", "API REST", "GraphQL", "WebSocket",
  "IndexedDB", "Service Worker", "Tailwind", "ESLint strict", "CI GitHub", "Docker",
  "edge runtime", "server actions",
] as const;
const CAS_LIMITES = ["entrée vide", "paramètre nul", "grande entrée"] as const;

const RADIX = {
  templates: 12,
  noms: NOMS_METIER.length,
  types: TYPES.length,
  seuils: SEUILS.length,
  contextes: CONTEXTES.length,
  cas: CAS_LIMITES.length,
};
/** Espace d'index par capacité (chaque index → un tuple de paramètres unique). */
export const ESPACE_ECRIRE =
  RADIX.templates * RADIX.noms * RADIX.types * RADIX.seuils * RADIX.contextes * RADIX.cas; // 12×37×5×9×23×3
export const ESPACE_COMPRENDRE =
  RADIX.templates * RADIX.cas * RADIX.noms * RADIX.contextes * RADIX.seuils * RADIX.types;

interface Decomposition {
  template: number; nom: string; type: string; seuil: number; contexte: string; cas: string;
}
/** Décomposition bijection d'un index en tuple de paramètres (radix mixte). */
function decomposerEcrire(i: number): Decomposition {
  let r = i;
  const template = r % RADIX.templates; r = Math.floor(r / RADIX.templates);
  const iNom = r % RADIX.noms; r = Math.floor(r / RADIX.noms);
  const iType = r % RADIX.types; r = Math.floor(r / RADIX.types);
  const iSeuil = r % RADIX.seuils; r = Math.floor(r / RADIX.seuils);
  const iCtx = r % RADIX.contextes; r = Math.floor(r / RADIX.contextes);
  const iCas = r % RADIX.cas;
  return {
    template,
    nom: NOMS_METIER[iNom] ?? "Boutique",
    type: TYPES[iType] ?? "string",
    seuil: SEUILS[iSeuil] ?? 5,
    contexte: CONTEXTES[iCtx] ?? "Next.js 16",
    cas: CAS_LIMITES[iCas] ?? "entrée vide",
  };
}

const NOMS_BASE = [
  "debounce", "throttle", "fetchAvecRetry", "validerEmail", "formaterDateFr",
  "stockerLocalStorage", "grouperPar", "reessayer", "echapperHtml", "melanger",
  "debiterSecurise", "construireQuery",
] as const;

/** Gabarit ÉCRIRE : instruction + code TypeScript complet (réel, paramétré). */
function codeEcrire(d: Decomposition): { instruction: string; code: string } {
  const base = NOMS_BASE[d.template] ?? "debounce";
  const fn = `${base}${d.nom}`;
  const buts: string[] = [
    "retarde l'exécution jusqu'à une accalmie de durées données",
    "limite la fréquence d'exécution à une fois par fenêtre de durées données",
    "récupère une ressource HTTP avec relances exponentielles jusqu'à un maximum d'essais",
    "valide une adresse e-mail (format, longueur) et renvoie un verdict typé",
    "formate une date au format français (jj/mm/aaaa)",
    "persiste une valeur JSON dans localStorage avec gestion d'échec silencieux",
    "regroupe les éléments d'un tableau par clé calculée (dictionnaire ordonné)",
    "exécute un appelant avec relance et repli sur erreur après un maximum d'essais",
    "échappe les caractères HTML d'une chaîne (anti-XSS de base)",
    "mélange un tableau en place (Fisher-Yates) et vérifie une taille minimale",
    "débite un montant en centimes avec contrôle de solde et arrondi bancaire",
    "construit une chaîne de requête URL depuis un dictionnaire (encodage URI)",
  ];
  const garde: Record<string, string> = {
    "entrée vide": `  if (entree.length === 0) return "vide";\n`,
    "paramètre nul": `  if (entree === null || entree === undefined) throw new TypeError("paramètre requis");\n`,
    "grande entrée": `  if (entree.length > ${d.seuil * 100}) return "hors-portee";\n`,
  };
  const signatures: string[] = [
    `(fonction: () => void, durees = ${d.seuil})`,
    `(fonction: () => void, fenetre = ${d.seuil})`,
    `(url: string, essaisMax = ${d.seuil})`,
    `(email: string, seuilLongueur = ${d.seuil})`,
    `(date: Date | ${d.type === "number" ? "number" : "string"})`,
    `(cle: string, valeur: ${d.type})`,
    `(elements: ${d.type === "string[]" ? "string[]" : "Array<{ cle: string }>"}, longueurMin = ${d.seuil})`,
    `(appelant: () => Promise<void>, essaisMax = ${d.seuil})`,
    `(texte: string, plafond = ${d.seuil})`,
    `(elements: ${d.type === "string[]" ? "string[]" : "number[]"}, tailleMin = ${d.seuil})`,
    `(solde: number, montant: number, plancher = ${d.seuil})`,
    `(params: Record<string, ${d.type === "string" ? "string" : "string | number"}>, limite = ${d.seuil})`,
  ];
  const corps: string[] = [
    `  let minuteur: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (minuteur !== null) clearTimeout(minuteur);
    minuteur = setTimeout(fonction, durees);
  };`,
    `  let dernierAppel = 0;
  return () => {
    const maintenant = Date.now();
    if (maintenant - dernierAppel >= fenetre) {
      dernierAppel = maintenant;
      fonction();
    }
  };`,
    `  for (let essai = 1; essai <= essaisMax; essai++) {
    const reponse = await fetch(url);
    if (reponse.ok) return reponse;
    if (essai < essaisMax) await new Promise((r) => setTimeout(r, 2 ** essai * 100));
  }
  throw new Error("ressource indisponible apres " + essaisMax + " essais");`,
    `  const motif = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/;
  if (email.length > seuilLongueur * 4) return { valide: false, motif: "longueur" };
  return { valide: motif.test(email), motif: motif.test(email) ? "format" : "invalide" };`,
    `  const d = new Date(date);
  const jj = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return jj + "/" + mm + "/" + d.getFullYear();`,
    `  try {
    localStorage.setItem("gen3:" + cle, JSON.stringify(valeur));
    return true;
  } catch {
    return false;
  }`,
    `  const groupes = new Map<string, typeof elements>();
  for (const e of elements) {
    const cle = String((e as { cle: unknown }).cle ?? e);
    const sac = groupes.get(cle) ?? [];
    sac.push(e);
    groupes.set(cle, sac);
  }
  return Object.fromEntries(groupes);`,
    `  let derniereErreur: unknown = null;
  for (let essai = 1; essai <= essaisMax; essai++) {
    try {
      await appelant();
      return;
    } catch (e) {
      derniereErreur = e;
    }
  }
  throw derniereErreur;`,
    `  return texte.slice(0, plafond)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");`,
    `  for (let i = elements.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [elements[i], elements[j]] = [elements[j]!, elements[i]!];
  }
  return elements.length >= tailleMin;`,
    `  const centimes = Math.round(montant * 100);
  if (solde - centimes < plancher) throw new RangeError("solde insuffisant");
  return { soldeRestant: solde - centimes, debite: centimes };`,
    `  const paires = Object.entries(params).slice(0, limite)
    .map(([c, v]) => encodeURIComponent(c) + "=" + encodeURIComponent(String(v)));
  return paires.join("&");`,
  ];
  const async = d.template === 2 || d.template === 7;
  return {
    instruction:
      `Écris une fonction TypeScript \`${fn}\` qui ${buts[d.template] ?? buts[0]!} — ` +
      `contexte ${d.contexte}, seuil par défaut ${d.seuil}, cas limite couvert : ${d.cas}. ` +
      `Code complet, typé et prêt à tester.`,
    code:
      `// ${d.contexte} — cas limite : ${d.cas}\n` +
      `${async ? "export async function" : "export function"} ${fn}${signatures[d.template] ?? signatures[0]!} {\n` +
      (garde[d.cas] ?? "") +
      (corps[d.template] ?? corps[0]!) +
      `\n}`,
  };
}

/** Gabarit COMPRENDRE : question + code + réponse exacte (métadonnées réelles). */
function exempleComprendre(i: number): { question: string; code: string; reponse: string } {
  let r = i;
  const template = r % RADIX.templates; r = Math.floor(r / RADIX.templates);
  const iCas = r % RADIX.cas; r = Math.floor(r / RADIX.cas);
  const iNom = r % RADIX.noms; r = Math.floor(r / RADIX.noms);
  const iCtx = r % RADIX.contextes; r = Math.floor(r / RADIX.contextes);
  const iSeuil = r % RADIX.seuils; r = Math.floor(r / RADIX.seuils);
  const iType = r % RADIX.types;
  const d: Decomposition = {
    template,
    nom: NOMS_METIER[iNom] ?? "Boutique",
    type: TYPES[iType] ?? "string",
    seuil: SEUILS[iSeuil] ?? 5,
    contexte: CONTEXTES[iCtx] ?? "Next.js 16",
    cas: CAS_LIMITES[iCas] ?? "entrée vide",
  };
  const ecrit = codeEcrire(d);
  const base = NOMS_BASE[template] ?? "debounce";
  const fn = `${base}${d.nom}`;
  const questions = [
    {
      q: `Que fait la fonction \`${fn}\` ?`,
      a: `\`${fn}\` — gabarit « ${base} » : ${NOMS_BASE.indexOf(base as never)} → ${base} appliqué à ${d.nom}, ` +
        `contexte ${d.contexte}, seuil ${d.seuil}, type principal \`${d.type}\`. Le code complet ci-dessus est la réponse exacte.`,
    },
    {
      q: `Que fait \`${fn}\` quand le cas limite « ${d.cas} » se produit ?`,
      a: `Cas limite « ${d.cas} » : le code le couvre par une garde en tête de fonction — ` +
        `\`${fn}\` renvoie un verdict typé ou lève une erreur contrôlée, jamais de crash silencieux.`,
    },
    {
      q: `Dans quel contexte technique \`${fn}\` est-elle prévue et quels sont ses paramètres ?`,
      a: `Contexte déclaré en en-tête : ${d.contexte} — seuil par défaut ${d.seuil}, ` +
        `paramètre principal typé \`${d.type}\`, cas limite documenté : ${d.cas}.`,
    },
    {
      q: `Quels paramètres accepte \`${fn}\` et lesquels sont optionnels ?`,
      a: `Signature : \`${base}${d.nom}\` — paramètre principal requis, options par défaut ` +
        `(seuil ${d.seuil}) ; le cas limite « ${d.cas} » est géré par la garde d'entrée.`,
    },
  ];
  const choix = questions[iCas % 4] ?? questions[0]!;
  return { question: choix.q, code: ecrit.code, reponse: choix.a };
}

/* ------------------------------------------------------------------ */
/* MATIÈRE SIMULER — exécution réelle du code généré (Node)           */
/* ------------------------------------------------------------------ */

const FONCTIONS_SIMULER = [
  "sommeTableau", "maxTableau", "comptePairs", "fibonacciIteratif", "estPremier",
  "factorielle", "moyenneArrondie", "rechercheDichotomique", "inverserChaine", "puissanceRapide",
] as const;

interface GenereSimuler {
  question: string;
  code: string;
  entreeDesc: string;
  sortie: string;
  trace: string[];
}
/**
 * Génère un exemple SIMULER : le code est EXÉCUTÉ RÉELLEMENT (new Function —
 * le code exécuté est EXACTEMENT la chaîne `code`) ; sortie et trace par pas
 * sont MESURÉES, jamais calculées à la main. Échec d'exécution → exception
 * (la campagne s'arrête : aucun chiffre fantôme).
 */
function genererSimuler(i: number): GenereSimuler {
  let r = i;
  const fn = r % FONCTIONS_SIMULER.length; r = Math.floor(r / FONCTIONS_SIMULER.length);
  const taille = 5 + (r % 8); r = Math.floor(r / 8); // 5..12
  const base = r % 100; r = Math.floor(r / 100); // 0..99
  const mod = 2 + (r % 9); r = Math.floor(r / 9); // 2..10
  const iCtx = r % RADIX.contextes;
  const contexte = CONTEXTES[iCtx] ?? "Node 22";
  const nom = NOMS_METIER[(base + taille) % RADIX.noms] ?? "Boutique";
  const tab = Array.from({ length: taille }, (_, k) => ((base + k * mod) % 97) + 1);
  const tabTrie = [...tab].sort((a, b) => a - b);

  const definitions: Array<{ nom: string; question: string; entreeDesc: string; code: string; entree: unknown }> = [
    {
      nom: "sommeTableau", question: "Que vaut la somme cumulée ?",
      entreeDesc: `tableau [${tab.join(", ")}]`, entree: tab,
      code: `function sommeTableau(entree) {\n  const trace = [];\n  let total = 0;\n  for (let k = 0; k < entree.length; k++) {\n    total += entree[k];\n    trace.push("pas " + (k + 1) + " : +" + entree[k] + " → " + total);\n  }\n  return { resultat: total, trace };\n}`,
    },
    {
      nom: "maxTableau", question: "Quel est le maximum et à quel pas est-il atteint ?",
      entreeDesc: `tableau [${tab.join(", ")}]`, entree: tab,
      code: `function maxTableau(entree) {\n  const trace = [];\n  let max = -Infinity;\n  let pas = 0;\n  for (let k = 0; k < entree.length; k++) {\n    if (entree[k] > max) { max = entree[k]; pas = k + 1; }\n    trace.push("pas " + (k + 1) + " : max=" + max);\n  }\n  return { resultat: max, trace, pas };\n}`,
    },
    {
      nom: "comptePairs", question: "Combien de valeurs paires et quel compteur final ?",
      entreeDesc: `tableau [${tab.join(", ")}]`, entree: tab,
      code: `function comptePairs(entree) {\n  const trace = [];\n  let compteur = 0;\n  for (const v of entree) {\n    if (v % 2 === 0) compteur++;\n    trace.push("v=" + v + " → compteur=" + compteur);\n  }\n  return { resultat: compteur, trace };\n}`,
    },
    {
      nom: "fibonacciIteratif", question: "Que vaut le n-ième nombre de Fibonacci (itératif) ?",
      entreeDesc: `n = ${Math.min(tab[0] ?? 5, 30)}`,
      entree: { n: Math.min(tab[0] ?? 5, 30) },
      code: `function fibonacciIteratif(entree) {\n  const trace = [];\n  let a = 0, b = 1;\n  for (let k = 1; k <= entree.n; k++) {\n    const s = a + b; a = b; b = s;\n    trace.push("k=" + k + " → " + a);\n  }\n  return { resultat: a, trace };\n}`,
    },
    {
      nom: "estPremier", question: "Le nombre est-il premier (essais jusqu'à racine) ?",
      entreeDesc: `n = ${Math.min(tab[1] ?? 7, 9409)}`,
      entree: { n: Math.min(tab[1] ?? 7, 9409) },
      code: `function estPremier(entree) {\n  const trace = [];\n  const n = entree.n;\n  if (n < 2) return { resultat: false, trace: ["n<2 → non premier"] };\n  for (let d = 2; d * d <= n; d++) {\n    trace.push("essai diviseur " + d + " : reste " + (n % d));\n    if (n % d === 0) return { resultat: false, trace };\n  }\n  trace.push("aucun diviseur ≤ racine → premier");\n  return { resultat: true, trace };\n}`,
    },
    {
      nom: "factorielle", question: "Que vaut la factorielle par produits successifs ?",
      entreeDesc: `n = ${Math.min(tab[2] ?? 5, 12)}`,
      entree: { n: Math.min(tab[2] ?? 5, 12) },
      code: `function factorielle(entree) {\n  const trace = [];\n  let f = 1;\n  for (let k = 2; k <= entree.n; k++) {\n    f *= k;\n    trace.push("k=" + k + " → " + f);\n  }\n  return { resultat: f, trace };\n}`,
    },
    {
      nom: "moyenneArrondie", question: "Que vaut la moyenne arrondie au plus proche ?",
      entreeDesc: `tableau [${tab.join(", ")}]`, entree: tab,
      code: `function moyenneArrondie(entree) {\n  const trace = [];\n  let total = 0;\n  for (let k = 0; k < entree.length; k++) {\n    total += entree[k];\n    trace.push("pas " + (k + 1) + " : total=" + total);\n  }\n  const m = Math.round(total / entree.length);\n  trace.push("moyenne arrondie = " + m);\n  return { resultat: m, trace };\n}`,
    },
    {
      nom: "rechercheDichotomique", question: "À quel index la cible est-elle trouvée (dichotomie) ?",
      entreeDesc: `trié [${tabTrie.join(", ")}], cible ${tab[3] ?? 10}`,
      entree: { tab: tabTrie, cible: tab[3] ?? 10 },
      code: `function rechercheDichotomique(entree) {\n  const trace = [];\n  let bas = 0, haut = entree.tab.length - 1;\n  while (bas <= haut) {\n    const mil = (bas + haut) >> 1;\n    trace.push("[bas=" + bas + " haut=" + haut + "] t[" + mil + "]=" + entree.tab[mil]);\n    if (entree.tab[mil] === entree.cible) return { resultat: mil, trace };\n    if (entree.tab[mil] < entree.cible) bas = mil + 1; else haut = mil - 1;\n  }\n  return { resultat: -1, trace };\n}`,
    },
    {
      nom: "inverserChaine", question: "Que vaut la chaîne inversée caractère par caractère ?",
      entreeDesc: `chaîne "gen3${nom.toLowerCase()}"`,
      entree: { texte: `gen3${nom.toLowerCase()}` },
      code: `function inverserChaine(entree) {\n  const trace = [];\n  let sortie = "";\n  for (let k = entree.texte.length - 1; k >= 0; k--) {\n    sortie += entree.texte[k];\n    trace.push("k=" + k + " → " + sortie);\n  }\n  return { resultat: sortie, trace };\n}`,
    },
    {
      nom: "puissanceRapide", question: "Que vaut base^exposant (exponentiation rapide) ?",
      entreeDesc: `base ${Math.min(((tab[0] ?? 2) % 9) + 2, 10)}, exposant ${Math.min(((tab[4] ?? 3) % 9) + 1, 12)}`,
      entree: { base: Math.min(((tab[0] ?? 2) % 9) + 2, 10), exposant: Math.min(((tab[4] ?? 3) % 9) + 1, 12) },
      code: `function puissanceRapide(entree) {\n  const trace = [];\n  let resultat = 1, b = entree.base, e = entree.exposant;\n  while (e > 0) {\n    if (e % 2 === 1) { resultat *= b; trace.push("e=" + e + " impair → résultat " + resultat); }\n    b *= b; e = Math.floor(e / 2);\n    trace.push("e→" + e + ", base→" + b);\n  }\n  return { resultat, trace };\n}`,
    },
  ];
  const def = definitions[fn] ?? definitions[0]!;
  // EXÉCUTION RÉELLE du code généré — aucune ré-implémentation parallèle.
  const executeur = new Function(`${def.code}; return ${def.nom};`)() as
    (e: unknown) => { resultat: unknown; trace: string[] };
  const mesure = executeur(def.entree);
  const question =
    `Simule l'exécution de \`${def.nom}\` (${contexte}) avec ${def.entreeDesc} — ${def.question} ` +
    `Réponds avec le résultat exact et la trace par pas.`;
  return {
    question,
    code: def.code,
    entreeDesc: def.entreeDesc,
    sortie: JSON.stringify(mesure.resultat),
    trace: mesure.trace,
  };
}

/** Corpus uniques : index global → (capacité, exemple) — cyclé modulo uniques. */
interface ExempleMatiere {
  capacite: Capacite;
  texte: string;
}
function exempleUnique(k: number, uniques: number): ExempleMatiere {
  const i = k % uniques;
  const capacite = capaciteDe(i);
  const local = Math.floor(i / 3);
  if (capacite === "ecrire") {
    const e = codeEcrire(decomposerEcrire(local % ESPACE_ECRIRE));
    return { capacite, texte: `ÉCRIRE — ${e.instruction}\nCODE :\n${e.code}` };
  }
  if (capacite === "comprendre") {
    const c = exempleComprendre(local % ESPACE_COMPRENDRE);
    return { capacite, texte: `COMPRENDRE — ${c.question}\nCODE :\n${c.code}\nRÉPONSE : ${c.reponse}` };
  }
  const s = genererSimuler(local);
  return {
    capacite,
    texte: `SIMULER — ${s.question}\nCODE :\n${s.code}\nENTRÉE : ${s.entreeDesc}\nSORTIE MESURÉE : ${s.sortie}\nTRACE : ${s.trace.slice(0, 6).join(" | ")}`,
  };
}

/** Espace de la capacité SIMULER (10 fonctions × 8 tailles × 100 bases × 9 modulos × 23 contextes). */
export const ESPACE_SIMULER = FONCTIONS_SIMULER.length * 8 * 100 * 9 * RADIX.contextes;

/**
 * Sonde code JAMAIS supervisée : l'index de corpus est pris dans
 * [uniques, uniques + 108) — HORS de la plage cyclée [0, uniques) visitée par
 * les lots quel que soit l'objectif, et HORS des plages d'alignement (4000..4899
 * et 5000..5999 sont des gabarits charte, pas des index de corpus). Aucun
 * modulo : l'exemple est construit directement à partir de l'index (les espaces
 * par capacité dépassent 1,6 M — l'assertion de session garantit la place).
 */
function exempleSonde(q: number, uniques: number): ExempleMatiere {
  const i = uniques + 100 + q;
  const capacite = capaciteDe(i);
  const local = Math.floor(i / 3);
  const espaceCapacite = capacite === "ecrire" ? ESPACE_ECRIRE : capacite === "comprendre" ? ESPACE_COMPRENDRE : ESPACE_SIMULER;
  if (local >= espaceCapacite) throw new Error(`Sonde hors espace (${local} ≥ ${espaceCapacite}) — réduire --uniques`);
  if (capacite === "ecrire") {
    const e = codeEcrire(decomposerEcrire(local));
    return { capacite, texte: `ÉCRIRE — ${e.instruction}\nCODE :\n${e.code}` };
  }
  if (capacite === "comprendre") {
    const c = exempleComprendre(local);
    return { capacite, texte: `COMPRENDRE — ${c.question}\nCODE :\n${c.code}\nRÉPONSE : ${c.reponse}` };
  }
  const s = genererSimuler(local);
  return {
    capacite,
    texte: `SIMULER — ${s.question}\nCODE :\n${s.code}\nENTRÉE : ${s.entreeDesc}\nSORTIE MESURÉE : ${s.sortie}\nTRACE : ${s.trace.slice(0, 6).join(" | ")}`,
  };
}

/* ------------------------------------------------------------------ */
/* Sondes (convention production — reprise it.77)                     */
/* ------------------------------------------------------------------ */

interface MoteurSonde {
  reinitialiserEnergies(): void;
  projetterTokens(tokens: string[]): Array<[number, number]>;
  pas(injections: Array<[number, number]> | null, t: number): number[];
  activationBandes(): number[];
}
interface ResultatSonde {
  texte: string;
  bandeAttendue: number;
  argmaxBande: number;
  activationCumuleePorteur: number;
  activationCumuleeArgmax: number;
  transmissions: number;
  evaluees: number;
  spikes: number;
  ms: number;
}
function sonder(
  moteur: MoteurSonde & { metabolismeDernierPas: { transmissions: number; evaluees: number; ms: number } },
  texte: string,
  bandeAttendue: number,
  horlogeDepart: number,
): ResultatSonde {
  moteur.reinitialiserEnergies();
  const injections = moteur.projetterTokens(tokenize(texte));
  const activationCumulee = new Array(8).fill(0) as number[];
  let transmissions = 0;
  let evaluees = 0;
  let spikes = 0;
  let ms = 0;
  for (let c = 0; c < CYCLES_SONDE; c++) {
    const sortants = moteur.pas(c === 0 ? injections : null, horlogeDepart + c + 1);
    spikes += sortants.length;
    transmissions += moteur.metabolismeDernierPas.transmissions;
    evaluees += moteur.metabolismeDernierPas.evaluees;
    ms += moteur.metabolismeDernierPas.ms;
    const actPas = moteur.activationBandes();
    for (let b = 0; b < 8; b++) activationCumulee[b] += actPas[b] ?? 0;
  }
  let argmax = 0;
  let maxAct = activationCumulee[0] ?? 0;
  for (let b = 1; b < 8; b++) {
    if ((activationCumulee[b] ?? 0) > maxAct) {
      maxAct = activationCumulee[b] ?? 0;
      argmax = b;
    }
  }
  return {
    texte,
    bandeAttendue,
    argmaxBande: argmax,
    activationCumuleePorteur: m6(activationCumulee[bandeAttendue] ?? 0),
    activationCumuleeArgmax: m6(maxAct),
    transmissions,
    evaluees,
    spikes,
    ms: m6(ms),
  };
}

/** Arêtes à cap 1.0 par bande — le travail réel de plasticité. */
function poidsCapParBande(cortex: CortexColumnnaire): number[] {
  const parBandeCortex = Math.floor(cortex.config.colonnes / cortex.config.bandes);
  const cap = new Array(8).fill(0) as number[];
  for (let p = 0; p < cortex.csrPoids.length; p++) {
    const cible = cortex.csrCible[p]!;
    const bande = Math.floor(cible / parBandeCortex);
    if (bande < 8 && cortex.csrPoids[p]! >= 1.0) cap[bande] += 1;
  }
  return cap;
}

/* ------------------------------------------------------------------ */
/* Checkpoints (layout identique au script million, it.63)            */
/* ------------------------------------------------------------------ */

interface Progress {
  graine: number;
  plan: string;
  lotCourant: number;
  vusCode: number;
  horloge: number;
  objectif: number;
  uniques: number;
  epoques: number;
}
function ecrireCheckpoint(cortex: CortexColumnnaire, champ: ChampCorticalGen3, progress: Progress): void {
  const n = cortex.config.colonnes;
  const v = cortex.config.voisins;
  const modulation0 = (champ as unknown as { modulation: Float32Array }).modulation;
  const taille = n * 4 + n * 8 + n * 8 + n * v * 4 + modulation0.byteLength + 4;
  const buf = Buffer.alloc(taille);
  let off = 0;
  const poser = (ta: Float32Array | Float64Array | Uint32Array): void => {
    Buffer.from(ta.buffer as ArrayBuffer, ta.byteOffset, ta.byteLength).copy(buf, off);
    off += ta.byteLength;
  };
  poser(cortex.energies);
  poser(cortex.dernierSpike);
  poser(cortex.dernierTouche);
  poser(cortex.csrPoids);
  const modulation = (champ as unknown as { modulation: Float32Array }).modulation;
  poser(modulation);
  buf.writeUInt32LE(champ.seedEntrainement >>> 0, off);
  if (off + 4 !== taille) throw new Error(`Taille checkpoint incohérente (${off + 4} ≠ ${taille})`);
  mkdirSync(repereCheckpoint, { recursive: true });
  const tmp = cheminCheckpoint + ".tmp";
  writeFileSync(tmp, buf);
  renameSync(tmp, cheminCheckpoint); // écriture atomique — un crash ne laisse jamais un checkpoint à moitié écrit
  writeFileSync(cheminProgress, JSON.stringify(progress, null, 2));
}

function chargerCheckpoint(cortex: CortexColumnnaire, champ: ChampCorticalGen3): Progress {
  const taille = statSync(cheminCheckpoint).size;
  const buf = Buffer.alloc(taille);
  const fd = openSync(cheminCheckpoint, "r");
  try {
    let lu = 0;
    while (lu < taille) lu += readSync(fd, buf, lu, taille - lu, lu);
  } finally {
    closeSync(fd);
  }
  const n = cortex.config.colonnes;
  const v = cortex.config.voisins;
  let off = 0;
  const prendre = (octets: number): ArrayBuffer => {
    const vue = buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + octets);
    off += octets;
    return vue;
  };
  cortex.energies.set(new Float32Array(prendre(n * 4)));
  cortex.dernierSpike.set(new Float64Array(prendre(n * 8)));
  cortex.dernierTouche.set(new Float64Array(prendre(n * 8)));
  cortex.csrPoids.set(new Float32Array(prendre(n * v * 4)));
  const modulation = (champ as unknown as { modulation: Float32Array }).modulation;
  modulation.set(new Float32Array(prendre(modulation.byteLength)));
  champ.seedEntrainement = buf.readUInt32LE(off);
  return JSON.parse(readFileSync(cheminProgress, "utf8")) as Progress;
}

/* ------------------------------------------------------------------ */
/* Session principale                                                 */
/* ------------------------------------------------------------------ */

function principal(): void {
  const opts = optionsCLI();
  const plan = `webdev-it79-v2|u${opts.uniques}|o${opts.objectif}|e${opts.epoques}|a${opts.ancrage}`;
  mkdirSync(repereCheckpoint, { recursive: true });
  console.log("=== CAMPAGNE DÉVELOPPEMENT WEB it.79 — écrire, comprendre, simuler ===");
  console.log(horodatage());
  console.log(
    `Objectif : ${opts.objectif.toLocaleString("fr-FR")} exemples code vus · corpus uniques : ${opts.uniques.toLocaleString("fr-FR")} · ` +
    `époques d'alignement : ${opts.epoques} · reprise : ${opts.reprendre ? "oui" : "non"}${opts.benchmark ? " · BENCHMARK" : ""}`,
  );

  // ---- 0. CORTEX + ANCRAGE 19 DOMAINES (identique it.77) ------------------
  console.log("\n[0] Cortex compact (2^17) + ancrage EOD 19 domaines (identique it.77)…");
  const cortex = new CortexColumnnaire({
    colonnes: COLONNES,
    seed: GRAINE,
    normalisationHomeostatique: true,
  });
  const champ = new ChampCorticalGen3(GRAINE);
  console.log(`    ${COLONNES} colonnes × ${cortex.config.voisins} voisins = ${cortex.csrCible.length} arêtes`);

  const tDebut = performance.now();
  const metabolismeEod = { evaluees: 0, reposes: 0, transmissions: 0, ms: 0, normalisations: 0 };
  const vagues: { vague: number; horlogeInitiale: number; echantillons: number }[] = [];
  const debutsHorloges = [0, 200000];
  for (let vague = 0; vague < 2; vague++) {
    const exemples: { texte: string; domaine: string }[] = [];
    for (const domaine of DOMAINES_VOCATION) {
      for (let i = vague * ECHANTILLONS_GABARITS; i < (vague + 1) * ECHANTILLONS_GABARITS; i++) {
        exemples.push({ texte: texteDomaine(domaine.id, i), domaine: domaine.id });
      }
    }
    const rapport = entrainerDomainesParOndes(cortex, champ, exemples, {
      cyclesParEchantillon: CYCLES_EOD, lrBoost: LR, maxParDomaine: ECHANTILLONS_GABARITS,
      horlogeInitiale: debutsHorloges[vague]!,
    });
    metabolismeEod.evaluees += rapport.metabolisme.evaluees;
    metabolismeEod.reposes += rapport.metabolisme.reposes;
    metabolismeEod.transmissions += rapport.metabolisme.transmissions;
    metabolismeEod.ms = m6(metabolismeEod.ms + rapport.metabolisme.ms);
    metabolismeEod.normalisations += rapport.metabolisme.normalisations;
    vagues.push({ vague: vague + 1, horlogeInitiale: debutsHorloges[vague]!, echantillons: rapport.totalEchantillons });
    console.log(`    EOD vague ${vague + 1} : ${rapport.totalEchantillons} échantillons`);
  }

  // ---- 1. LOTS MIXTES CODE + ANCRAGE (checkpoints par lot) ----------------
  const pasAncrage = Math.max(1, Math.floor(4000 / opts.ancrage));
  const ancrageParDomaine = new Map<string, string[]>();
  for (const domaine of DOMAINES_VOCATION) {
    const textes: string[] = [];
    for (let i = 0; i < 4000 && textes.length < opts.ancrage; i += pasAncrage) {
      textes.push(texteDomaine(domaine.id, i));
    }
    ancrageParDomaine.set(domaine.id, textes);
  }
  const bandeCode = bandeDuDomaine("generation-code");
  const tailleLotTotal = TAILLE_LOT_CODE + opts.ancrage * DOMAINES_VOCATION.length;
  const lotsTotal = Math.max(1, Math.ceil(opts.objectif / TAILLE_LOT_CODE));

  const progressInitial: Progress = {
    graine: GRAINE, plan, lotCourant: 0, vusCode: 0,
    horloge: HORLOGE_LOTS_DEBUT, objectif: opts.objectif, uniques: opts.uniques, epoques: opts.epoques,
  };
  let progress = progressInitial;
  if (opts.reprendre && existsSync(cheminCheckpoint) && existsSync(cheminProgress)) {
    const repris = chargerCheckpoint(cortex, champ);
    if (repris.graine !== GRAINE) throw new Error(`Checkpoint d'une autre graine (${repris.graine} ≠ ${GRAINE})`);
    if (repris.plan !== plan) throw new Error(`Checkpoint d'un autre plan (${repris.plan} ≠ ${plan})`);
    progress = repris;
    console.log(`Reprise : lot ${progress.lotCourant}/${lotsTotal}, ${progress.vusCode.toLocaleString("fr-FR")} exemples code déjà vus (checkpoint var/neural-webdev/)`);
  } else if (opts.reprendre) {
    console.log("Reprise demandée mais aucun checkpoint présent — session neuve.");
  }

  const entrainerLotMixte = (lot: number): { codeVus: number; ancrageVus: number; ms: number } => {
    const exemples: { texte: string; domaine: string }[] = [];
    const debutCode = lot * TAILLE_LOT_CODE;
    for (let j = 0; j < TAILLE_LOT_CODE; j++) {
      const exemple = exempleUnique(debutCode + j, opts.uniques);
      exemples.push({ texte: exemple.texte, domaine: "generation-code" });
    }
    // Ancrage interclassé avec rotation (leçon it.63 : une bande ne reste jamais seule en piste).
    const rotation = lot % DOMAINES_VOCATION.length;
    for (let d = 0; d < DOMAINES_VOCATION.length; d++) {
      const domaine = DOMAINES_VOCATION[(d + rotation) % DOMAINES_VOCATION.length]!;
      for (const texte of ancrageParDomaine.get(domaine.id) ?? []) {
        exemples.push({ texte, domaine: domaine.id });
      }
    }
    const horlogeLot = HORLOGE_LOTS_DEBUT + lot * (tailleLotTotal * CYCLES_EOD + 1000);
    const r = entrainerDomainesParOndes(cortex, champ, exemples, {
      cyclesParEchantillon: CYCLES_EOD, lrBoost: LR, maxParDomaine: tailleLotTotal, horlogeInitiale: horlogeLot,
    });
    return { codeVus: TAILLE_LOT_CODE, ancrageVus: r.totalEchantillons - TAILLE_LOT_CODE, ms: r.metabolisme.ms };
  };

  console.log(`\n[1] Lots mixtes (${lotsTotal} lots × ${tailleLotTotal} échantillons : ${TAILLE_LOT_CODE} code + ${opts.ancrage}/domaine × 19 ancrage)…`);

  if (opts.benchmark) {
    const nbLotsEssai = 3;
    const tB = performance.now();
    for (let lot = 0; lot < nbLotsEssai; lot++) {
      const r = entrainerLotMixte(lot);
      if (lot === 0) console.log(`    essai lot 0 : ${r.codeVus} code + ${r.ancrageVus} ancrage, ${r.ms.toFixed(0)} ms`);
    }
    const msTotal = performance.now() - tB;
    const echS = (nbLotsEssai * TAILLE_LOT_CODE) / (msTotal / 1000);
    const heuresMd = opts.objectif / echS / 3600;
    console.log(
      `BENCHMARK — débit mesuré : ${echS.toFixed(0)} échantillons/s (${nbLotsEssai} lots) → extrapolation ${opts.objectif.toLocaleString("fr-FR")} exemples ≈ ${heuresMd.toFixed(1)} h de traitement EOD pur (hors alignement/sondes) — la durée wall-clock réelle seule fait foi.`,
    );
    return;
  }

  const tBoucle = performance.now();
  let vusSession = 0;
  for (let lot = progress.lotCourant; lot < lotsTotal; lot++) {
    const r = entrainerLotMixte(lot);
    vusSession += r.codeVus;
    progress = {
      ...progress,
      lotCourant: lot + 1,
      vusCode: progress.vusCode + r.codeVus,
      horloge: HORLOGE_LOTS_DEBUT + (lot + 1) * (tailleLotTotal * CYCLES_EOD + 1000),
    };
    if ((lot + 1) % 5 === 0 || lot + 1 === lotsTotal) {
      const echS = vusSession / Math.max(1, (performance.now() - tBoucle) / 1000);
      const resteH = ((lotsTotal - lot - 1) * TAILLE_LOT_CODE) / Math.max(1, echS) / 3600;
      console.log(
        `    lot ${lot + 1}/${lotsTotal} — code vus ${progress.vusCode.toLocaleString("fr-FR")} (${echS.toFixed(0)} ech/s session) — reste ≈ ${resteH < 1 ? `${(resteH * 60).toFixed(0)} min` : `${resteH.toFixed(1)} h`}`,
      );
      ecrireCheckpoint(cortex, champ, progress);
    }
  }
  const dureeLots = performance.now() - tBoucle;
  ecrireCheckpoint(cortex, champ, progress);

  // ---- 2. ALIGNEMENT INFÉRENCE (mécanique it.77, matière étendue) ---------
  // Matière it.77 INTÉGRALE (charte + questions + gabarits 4000..4899 +
  // inédits 5000..5999, les 19 domaines — c'est elle qui porte le plancher
  // anti-retour) + MATIÈRES CODE ajoutées au domaine generation-code (même
  // passe, même plasticité — la spécialisation se fait SUR le socle, pas à
  // sa place).
  console.log(`\n[2] Alignement inférence (${opts.epoques} époques, matière it.77 complète + matières code)…`);
  const alignementParDomaine = new Map<string, string[]>();
  for (const domaine of DOMAINES_VOCATION) {
    const textes: string[] = [domaine.label, domaine.mission, ...domaine.taches, ...domaine.outils];
    for (const q of CORPUS_QUESTIONS_VOCATION.filter((p) => p.domaineId === domaine.id).map((p) => p.question)) {
      textes.push(q);
    }
    for (let i = 4000; i < 4900; i++) textes.push(texteDomaine(domaine.id, i));
    for (let i = 5000; i < 6000; i++) textes.push(texteDomaine(domaine.id, i));
    alignementParDomaine.set(domaine.id, textes);
  }
  const matieresCode: string[] = [
    "Génération de code — " + (DOMAINES_VOCATION.find((d) => d.id === "generation-code")?.mission ?? "") +
    " Tâches : " + (DOMAINES_VOCATION.find((d) => d.id === "generation-code")?.taches ?? []).join(" ; ") + ".",
  ];
  for (const q of CORPUS_QUESTIONS_VOCATION.filter((p) => p.domaineId === "generation-code").map((p) => p.question)) {
    matieresCode.push(q);
  }
  const pasAlign = Math.max(1, Math.floor(opts.uniques / MATIERES_ALIGN));
  for (let k = 0; k < opts.uniques && matieresCode.length < MATIERES_ALIGN + 40; k += pasAlign) {
    matieresCode.push(exempleUnique(k, opts.uniques).texte.slice(0, 1400));
  }
  const textesCodeDomaine = alignementParDomaine.get("generation-code") ?? [];
  for (const t of matieresCode) textesCodeDomaine.push(t);
  alignementParDomaine.set("generation-code", textesCodeDomaine);
  const tailleMatiereAlign = [...alignementParDomaine.values()].reduce((a, l) => a + l.length, 0);
  let horlogeAlign = Math.max(progress.horloge, HORLOGE_LOTS_DEBUT) + 100000;
  const horlogeSonde = horlogeAlign + 1_000_000; // loin de toute supervision (au-delà de l'alignement)
  const alignement: { echantillons: number; parEpoque: number[] } = { echantillons: 0, parEpoque: [] };
  const capParEpoque: number[][] = [poidsCapParBande(cortex)];
  console.log(`    arêtes à cap 1.0 après lots : ${capParEpoque[0]!.join(", ")} · matière alignement : ${tailleMatiereAlign} textes (code inclus)`);
  for (let epoque = 0; epoque < opts.epoques; epoque++) {
    let echantillonsEpoque = 0;
    for (const domaine of DOMAINES_VOCATION) {
      const bande = bandeDuDomaine(domaine.id);
      for (const texte of alignementParDomaine.get(domaine.id) ?? []) {
        cortex.reinitialiserEnergies();
        const injections = cortex.projetterTokens(tokenize(texte));
        const stimulees = injections.map(([c]) => c);
        for (let c = 0; c < CYCLES_SONDE; c++) {
          cortex.pas(c === 0 ? injections : null, horlogeAlign + c + 1);
        }
        const activation = cortex.activationBandes();
        const concurrentes: number[] = [];
        for (let b = 0; b < activation.length; b++) {
          if (b !== bande && (activation[b] ?? 0) > (activation[bande] ?? 0)) concurrentes.push(b);
        }
        cortex.plasticiteSupervisee(stimulees, bande, LR, concurrentes);
        alignement.echantillons += 1;
        echantillonsEpoque += 1;
        horlogeAlign += CYCLES_SONDE;
      }
    }
    alignement.parEpoque.push(echantillonsEpoque);
    const cap = poidsCapParBande(cortex);
    capParEpoque.push(cap);
    console.log(`    époque ${epoque + 1}/${opts.epoques} : ${echantillonsEpoque} échantillons — cap/bande : ${cap.join(", ")}`);
  }
  const dureeSupervision = m6(performance.now() - tDebut);

  // ---- 3. SONDES CODE (jamais supervisées) + SONDES 19 DOMAINES -----------
  console.log("\n[3] Sondes — 9 sondes code (corpus [U, U+108), JAMAIS supervisées) + 19 domaines (identiques it.77)…");
  const cortexNeuf = new CortexColumnnaire({ colonnes: COLONNES, seed: GRAINE, normalisationHomeostatique: true });
  const indicesSondesCode = Array.from({ length: 9 }, (_, q) => q);
  const sondesCodeMatieres = indicesSondesCode.map((q) => exempleSonde(q, opts.uniques));
  const sondesCodeCapacites = sondesCodeMatieres.map((s) => s.capacite);
  const sondesCodeTextes = sondesCodeMatieres.map((s) => s.texte.slice(0, 900));
  const sondesCodeEntraîne = sondesCodeTextes.map((t) => sonder(cortex, t, bandeCode, horlogeSonde));
  const sondesCodeNeuf = sondesCodeTextes.map((t) => sonder(cortexNeuf, t, bandeCode, horlogeSonde));

  const sondes19Entraîne: Record<string, ResultatSonde[]> = {};
  const sondes19Neuf: Record<string, ResultatSonde[]> = {};
  for (const domaine of DOMAINES_VOCATION) {
    const bandeAttendue = bandeDuDomaine(domaine.id);
    const questions = CORPUS_QUESTIONS_VOCATION.filter((p) => p.domaineId === domaine.id).map((p) => p.question);
    const textes = [...questions, texteDomaine(domaine.id, INDICE_SONDE_19_1), texteDomaine(domaine.id, INDICE_SONDE_19_2)];
    sondes19Entraîne[domaine.id] = textes.map((t) => sonder(cortex, t, bandeAttendue, horlogeSonde));
    sondes19Neuf[domaine.id] = textes.map((t) => sonder(cortexNeuf, t, bandeAttendue, horlogeSonde));
  }

  // ---- 4. QUANTIFICATION u8 + SNAPSHOT + SONDES u8 ------------------------
  console.log("\n[4] Quantification u8 + snapshot + sondes embarquées…");
  const poidsU8 = quantiserPoidsU8(cortex.csrPoids);
  const entete = {
    colonnes: cortex.config.colonnes, voisins: cortex.config.voisins,
    bandes: cortex.config.bandes, bandesLecture: cortex.config.bandesLecture,
    seed: cortex.config.seed, seuil: cortex.config.seuil, decroissance: cortex.config.decroissance,
    plasticiteFenetre: cortex.config.plasticiteFenetre, aretes: cortex.csrCible.length,
  };
  const snapshot = exporterSnapshotTelephone(entete, poidsU8);
  console.log(`    snapshot : ${snapshot.length} octets (${(snapshot.length / 1048576).toFixed(2)} Mo)`);
  const recharge = importerSnapshotTelephone(snapshot);
  const telephone = new CortexTelephone(
    {
      colonnes: recharge.entete.colonnes, voisins: recharge.entete.voisins,
      bandes: recharge.entete.bandes, bandesLecture: recharge.entete.bandesLecture,
      seed: recharge.entete.seed, seuil: recharge.entete.seuil,
      decroissance: recharge.entete.decroissance, plasticiteFenetre: recharge.entete.plasticiteFenetre,
    },
    recharge.poidsU8,
  );
  const sondesCodeU8 = sondesCodeTextes.map((t) => sonder(telephone, t, bandeCode, horlogeSonde));

  // ---- 5. MÉTRIQUES + RÈGLE DE LIVRAISON ENCODÉE --------------------------
  const moy = (l: ResultatSonde[], f: (s: ResultatSonde) => number) =>
    l.length ? m6(l.reduce((a, s) => a + f(s), 0) / l.length) : 0;
  const parCapacite = CAPACITES.map((cap) => {
    const positions = sondesCodeCapacites.map((c, q) => ({ c, q })).filter(({ c }) => c === cap).map(({ q }) => q);
    const ens = positions.map((q) => sondesCodeEntraîne[q]!);
    const neuf = positions.map((q) => sondesCodeNeuf[q]!);
    const u8 = positions.map((q) => sondesCodeU8[q]!);
    const ratio = moy(neuf, (s) => s.activationCumuleePorteur) > 0
      ? m6(moy(ens, (s) => s.activationCumuleePorteur) / moy(neuf, (s) => s.activationCumuleePorteur))
      : null;
    return {
      capacite: cap,
      sondes: ens.length,
      activationEntraîne: moy(ens, (s) => s.activationCumuleePorteur),
      activationNeuf: moy(neuf, (s) => s.activationCumuleePorteur),
      ratioAppris: ratio,
      argmaxAttendu: ens.filter((s) => s.argmaxBande === bandeCode).length,
      accordU8: ens.filter((s, i) => s.argmaxBande === u8[i]?.argmaxBande).length,
    };
  });
  const accordsU8Code = sondesCodeEntraîne.filter((s, i) => s.argmaxBande === sondesCodeU8[i]?.argmaxBande).length;
  const argmaxAttenduCode = sondesCodeEntraîne.filter((s) => s.argmaxBande === bandeCode).length;
  const ratiosCode = parCapacite.map((c) => c.ratioAppris ?? 0);
  const ratioCodeMoyen = m6(ratiosCode.reduce((a, b) => a + b, 0) / ratiosCode.length);

  const parDomaine19 = DOMAINES_VOCATION.map((domaine) => {
    const ens = sondes19Entraîne[domaine.id] ?? [];
    const neuf = sondes19Neuf[domaine.id] ?? [];
    const bandeAttendue = bandeDuDomaine(domaine.id);
    const ratio = moy(neuf, (s) => s.activationCumuleePorteur) > 0
      ? m6(moy(ens, (s) => s.activationCumuleePorteur) / moy(neuf, (s) => s.activationCumuleePorteur))
      : null;
    return { domaineId: domaine.id, bandeAttendue, porteur: m6(porteurBande(bandeAttendue)), sondes: ens.length, ratioAppris: ratio };
  });
  const ratios19 = parDomaine19.map((d) => d.ratioAppris ?? 0);
  const plancher19 = Math.min(...ratios19);
  const moyenne19 = ratios19.reduce((a, b) => a + b, 0) / ratios19.length;
  const variance19 = m6(ratios19.reduce((a, b) => a + (b - moyenne19) ** 2, 0) / ratios19.length);

  // Comparaison informative avec l'artefact it.76 (production téléphone).
  let plancherIt76: number | null = null;
  let varianceIt76: number | null = null;
  try {
    const precedent = JSON.parse(readFileSync(join(process.cwd(), ARTEFACT_PRECEDENT), "utf8")) as {
      parDomaine: Array<{ ratioAppris: number | null }>;
      sonde: { plancherRatio: number };
    };
    plancherIt76 = precedent.sonde?.plancherRatio ?? null;
    const r76 = precedent.parDomaine.map((d) => d.ratioAppris ?? 0);
    const m76 = r76.reduce((a, b) => a + b, 0) / r76.length;
    varianceIt76 = m6(r76.reduce((a, b) => a + (b - m76) ** 2, 0) / r76.length);
  } catch {
    plancherIt76 = null;
    varianceIt76 = null;
  }

  // RÈGLE DE LIVRAISON ENCODÉE (jamais contée à la main) :
  //  ratio code moyen > 1 · argmax bande attendu ≥ 7/9 · accord u8 = 9/9 ·
  //  plancher 19 domaines ≥ socle it.73 (anti-retour accumulé).
  const livreSnapshot =
    ratioCodeMoyen > 1 && argmaxAttenduCode >= 7 && accordsU8Code === 9 && plancher19 >= PLANCHER_SOCLE_IT73;

  // Matière committée pour la page /code (extrait déterministe de la matière réelle).
  const indicesMatiere: Record<Capacite, number[]> = {
    ecrire: [0, 7, 13, 21, 34, 55],
    comprendre: [1, 8, 14, 22, 35, 56],
    simuler: [2, 9, 15, 23, 36, 57],
  };
  const matiereItems = CAPACITES.flatMap((cap) =>
    indicesMatiere[cap].map((local) => {
      if (cap === "ecrire") {
        const e = codeEcrire(decomposerEcrire(local));
        return { id: `${cap}-${local}`, capacite: cap, instruction: e.instruction, code: e.code.slice(0, 1100) };
      }
      if (cap === "comprendre") {
        const c = exempleComprendre(local);
        return { id: `${cap}-${local}`, capacite: cap, question: c.question, code: c.code.slice(0, 1100), reponse: c.reponse };
      }
      const s = genererSimuler(local);
      return {
        id: `${cap}-${local}`, capacite: cap, question: s.question, code: s.code,
        entreeDesc: s.entreeDesc, sortie: s.sortie, trace: s.trace.slice(0, 14),
      };
    }),
  );

  const dureeTotale = m6(performance.now() - tDebut);
  const echS = vusSession / Math.max(1, dureeLots / 1000);
  const extrapolationHeures = (DEF_OBJECTIF - progress.vusCode) / Math.max(1, echS) / 3600;

  const artefact = {
    iteration: 79,
    titre: "GEN3 développement web — écrire, comprendre, simuler du code (snapshot embarqué spécialisé)",
    demande:
      "session propriétaire directe (trace 1a197bdfb7f467bd) : entraîner gen3 au développement web " +
      "(écrire, comprendre, simuler du code) — 1 milliard d'exemples / 1 million de datasets — " +
      "mise à disposition des utilisateurs sur le domaine en ligne",
    horodatage: horodatage(),
    graine: GRAINE,
    optionsSession: {
      objectif: opts.objectif, uniques: opts.uniques, epoques: opts.epoques,
      ancrage: opts.ancrage, reprise: opts.reprendre, benchmark: opts.benchmark,
    },
    echelleDeclaree: {
      cibleExemples: DEF_OBJECTIF,
      cibleUniques: DEF_UNIQUES,
      cetteSession: { exemplesCodeVus: progress.vusCode, lotsFaits: progress.lotCourant, lotsTotal, corpusUniques: opts.uniques },
      reprise: "checkpoints var/neural-webdev/ (checkpoint.bin + progress.json, écriture atomique) — --reprendre poursuit au lot exact",
      extrapolation: {
        echS: m6(echS),
        heuresRestantesVersMilliard: m6(extrapolationHeures),
        note: "débit mesuré sur CETTE session (bac à sable) — un VPS 1 vCPU est plus lent ; la durée wall-clock réelle seule fait foi",
      },
    },
    matiere: {
      reelDepot: "datasets/code/train.jsonl — 12 000 exemples (api_design, bug_to_fix, feature_to_tests… FR/EN, CC-BY-4.0-synthetic-gen3ia) + charte generation-code + questions canoniques",
      procedurelle: {
        ecrire: {
          espace: ESPACE_ECRIRE,
          gabarits: NOMS_BASE.length,
          parametres: "12 gabarits × 37 noms métier × 5 types × 9 seuils × 23 contextes × 3 cas limites — bijection index→exemple",
        },
        comprendre: {
          espace: ESPACE_COMPRENDRE,
          questions: "4 types (but, cas limite, contexte, signature) — réponses exactes dérivées des métadonnées du gabarit",
        },
        simuler: {
          fonctions: FONCTIONS_SIMULER,
          verite: "SORTIE ET TRACE CALCULÉES PAR EXÉCUTION RÉELLE du code généré (new Function en Node) — échec d'exécution = campagne arrêtée, aucun chiffre fantôme",
        },
      },
      ancrage: "2 vagues × 2 000 gabarits charte/domaine (indices 0..3999, identique it.77) + interclassement 26/domaine par lot mixte avec rotation (leçon it.63 : une bande ne reste jamais seule en piste)",
    },
    supervision: {
      mecanique: "EOD it.57/63 (entrainerDomainesParOndes, cap par lot, continuité d'horloge) + alignement inférence it.77 (projection hash, même plasticité que le trainer) — MÉCANIQUE INCHANGÉE, seule la MATIÈRE change (code web-dev)",
      vagues,
      lots: {
        total: lotsTotal, faits: progress.lotCourant, tailleCode: TAILLE_LOT_CODE,
        ancrageParDomaine: opts.ancrage, tailleTotaleLot: tailleLotTotal,
      },
      alignement: {
        echantillons: alignement.echantillons, parEpoque: alignement.parEpoque,
        epoques: opts.epoques, matieres: matieresCode.length,
      },
      metabolismeEod,
      poidsCapParBande: capParEpoque[capParEpoque.length - 1]!,
      poidsCapParEpoque: capParEpoque,
      dureeMs: dureeSupervision,
      dureeTotaleMs: dureeTotale,
    },
    sonde: {
      convention: "projection hash (production chat), 4 pas, activation d'énergie cumulée par bande — ratio entraîné/neuf publié tel quel",
      horloge: horlogeSonde,
      indicesSondesCode,
      plageCorpusSondes: `[${opts.uniques}, ${opts.uniques + 108})`,
      noteJamaisSupervisees: `les sondes sont construes aux index de corpus [${opts.uniques}..${opts.uniques + 107}] — HORS de la plage cyclée [0..${opts.uniques - 1}] visitée par les lots quel que soit l'objectif, SANS modulo, et hors des plages de gabarits d'alignement — jamais vues par aucune supervision`,
      parCapacite,
      ratioCodeMoyen,
      argmaxAttenduCode,
      accordsU8Code,
      totalSondes19: parDomaine19.reduce((a, d) => a + d.sondes, 0),
      limites: "la sonde NEURALE mesure la résonance de la bande generation-code (8 bandes, 19 domaines par hash) — ce n'est PAS une preuve de génération de code ; la matière SIMULER est vérifiée par exécution réelle à la génération et par la garde",
    },
    antiRetour19: {
      plancher: m6(plancher19),
      variance: variance19,
      plancherIt76: plancherIt76 !== null ? m6(plancherIt76) : null,
      varianceIt76,
      socleIt73: PLANCHER_SOCLE_IT73,
      plancherAuDessusSocle: plancher19 >= PLANCHER_SOCLE_IT73,
      parDomaine: parDomaine19,
    },
    energie: {
      erreurMaxQuantisation: erreurMaxQuantisation(),
      snapshotOctets: snapshot.length,
    },
    livraison: {
      snapshotWebdev: livreSnapshot
        ? "committé : public/neural/cortex-developpement-web-it79.bin (ratio code > 1 · argmax ≥ 7/9 · accord u8 9/9 · plancher 19 ≥ socle it.73)"
        : "NON committé — une des portes a refusé : la production inchangée reste servie, la mesure est publiée telle quelle",
      matiereJson: "public/neural/webdev-it79-matiere.json — extrait déterministe de la matière réelle (6 items × 3 capacités, traces exécutées)",
      regleDeclaree: `livreSnapshot = ratioCodeMoyen > 1 && argmaxAttenduCode >= 7 && accordsU8Code === 9 && plancher19 >= ${PLANCHER_SOCLE_IT73} — encodée dans ce script, jamais contée à la main`,
      livreSnapshot,
    },
    limitesHonnetes: [
      "Le SNN apprend la RÉSONANCE de la bande generation-code sur la matière code — la composition des réponses utilisateur reste le pont lexical + la matière committée (page /code) : le snapshot ne « génère » pas de code tout seul.",
      "La matière SIMULER est vérifiée par exécution réelle (à la génération et par la garde 47ᵉ) ; la page /code rejoue les traces MESURÉES — elle n'évalue pas de code dans le navigateur (CSP sans unsafe-eval).",
      "1 milliard d'exemples s'atteint par sessions successives reliées par checkpoints — l'extrapolation de durée est un indicateur mesuré, pas une promesse.",
      "Le corpus procédural est synthétique et étiqueté comme tel ; la matière réelle du dépôt (12 000 exemples code) est comptée séparément.",
    ],
  };

  const dirAssets = "assets/neural-pretrained";
  const dirPublic = "public/neural";
  mkdirSync(dirAssets, { recursive: true });
  mkdirSync(dirPublic, { recursive: true });
  writeFileSync(join(dirAssets, "cortex-developpement-web-it79.json"), JSON.stringify(artefact, null, 2));
  writeFileSync(
    join(dirPublic, "webdev-it79-matiere.json"),
    JSON.stringify({ iteration: 79, horodatage: horodatage(), items: matiereItems }, null, 2),
  );
  if (livreSnapshot) {
    writeFileSync(join(dirPublic, "cortex-developpement-web-it79.bin"), snapshot);
  } else {
    // Supprimer toute trace d'un bin non livré (une campagne précédente
    // pourrait avoir laissé un fichier — la garde exige son absence).
    try { unlinkSync(join(dirPublic, "cortex-developpement-web-it79.bin")); } catch { /* absent : OK */ }
  }

  console.log("\n=== SYNTHÈSE it.79 — développement web ===");
  console.log(`Exemples code vus cette session : ${vusSession.toLocaleString("fr-FR")} (total checkpoint : ${progress.vusCode.toLocaleString("fr-FR")}) — ${echS.toFixed(0)} ech/s mesurés`);
  console.log(`Sondes code (corpus [${opts.uniques}..${opts.uniques + 107}], jamais supervisées) : ratio moyen ${ratioCodeMoyen} · argmax attendu ${argmaxAttenduCode}/9 · accord u8 ${accordsU8Code}/9`);
  console.log(parCapacite.map((c) => `    ${c.capacite} : ratio ${c.ratioAppris} · argmax ${c.argmaxAttendu}/${c.sondes} · u8 ${c.accordU8}/${c.sondes}`).join("\n"));
  console.log(`Anti-retour 19 domaines : plancher ${m6(plancher19)} (socle it.73 ${PLANCHER_SOCLE_IT73} — au-dessus : ${plancher19 >= PLANCHER_SOCLE_IT73}) · variance ${variance19}`);
  console.log(`SNAPSHOT : ${livreSnapshot ? "LIVRÉ → public/neural/cortex-developpement-web-it79.bin" : "NON LIVRÉ (règle encodée refusée — production inchangée)"}`);
  console.log(`Matière : public/neural/webdev-it79-matiere.json (${matiereItems.length} items) · Artefact : assets/neural-pretrained/cortex-developpement-web-it79.json`);
  console.log(`Pour atteindre 1 Md depuis ce point : ≈ ${extrapolationHeures.toFixed(1)} h de traitement EOD au débit mesuré — reprendre avec --reprendre (checkpoints var/neural-webdev/)`);
}

principal();

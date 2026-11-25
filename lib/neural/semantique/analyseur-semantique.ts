/**
 * ANALYSEUR SÉMANTIQUE (LOT 2 — compréhension sémantique générale du
 * cerveau Gen3, sans IA externe).
 *
 * Au-dessus de l'encodage LEXICAL existant (tokenize + racineLegere du
 * cortex langagier), cet analyseur ajoute la couche RELATIONNELLE :
 *  - expansion par synonymes (lexique-relations.ts) — deux phrases qui
 *    partagent le sens mais pas les mots obtiennent un score de similarité
 *    élevé (le lexical pur les rate) ;
 *  - détection de NÉGATION — « le chat dort » / « le chat ne dort pas »
 *    sont lexicalement identiques et sémantiquement opposés ;
 *  - typage de la QUESTION (quoi/qui/quand/où/comment/pourquoi/combien)
 *    — base du routage de génération ;
 *  - extraction de CONCEPTS (racines informatives enrichies de leurs
 *    relations : catégories, parties) — base du raisonnement (LOT 5).
 *
 * Tout est déterministe, borné, testable — et honnête : ce module ne
 * prétend pas à la compréhension du sens profond par immersion statistique,
 * il apporte la couche relationnelle MANQUANTE au cerveau.
 */

import { tokenize } from "../encoding/text-encoder";
import { racineLegere } from "../generation/language";
import { construireIndexSemantique, tailleLexique, type IndexSemantique } from "./lexique-relations";

/** Index construit une seule fois (singleton paresseux — RAM bornée). */
let indexCache: IndexSemantique | null = null;
function index(): IndexSemantique {
  if (!indexCache) indexCache = construireIndexSemantique(racineLegere);
  return indexCache;
}

/** Marqueurs de négation français (contractions incluses). */
const NEGATIONS = ["pas", "jamais", "aucun", "aucune", "rien", "nul", "ni", "sans"];
const PREFIXES_NEGATION = /^(n'|ne)$/i;

export type TypeQuestion =
  | "defini" | "explique" | "qui" | "quand" | "ou"
  | "comment" | "pourquoi" | "combien" | "liste" | "aucune";

/** Analyse sémantique complète d'un texte français. */
export interface AnalyseSemantique {
  /** Racines informatives (hors stopwords). */
  racines: string[];
  /** Racines étendues par synonymes directs (1 niveau). */
  racinesEtendues: string[];
  /** La phrase contient-elle une négation ? */
  negation: boolean;
  /** Type de question détecté (aucune si affirmation). */
  question: TypeQuestion;
  /** Concepts : racines + catégories/instances/parties connues du lexique. */
  concepts: Array<{
    racine: string;
    categories: string[];
    instances: string[];
    parties: string[];
  }>;
  /** Les thèmes lexicaux repérés (catégories du lexique présentes). */
  themes: string[];
}

/** Mots de question (ordre de détection = priorité). */
const DETECTEURS_QUESTION: ReadonlyArray<readonly [RegExp, TypeQuestion]> = [
  [/^pourquoi\b/i, "pourquoi"],
  [/^comment\b/i, "comment"],
  [/^combien\b/i, "combien"],
  [/^qui\b/i, "qui"],
  [/^(que|quoi|qu')/i, "defini"],
  [/^(quand|lorsque|date)/i, "quand"],
  [/^(ou|où)\b/i, "ou"],
  [/^(explique|definition|definis|definir)/i, "explique"],
  [/^(liste|enumerate|cites)/i, "liste"],
];

/** ANALSE un texte : racines, négation, question, concepts enrichis. */
export function analyserSemantique(texte: string): AnalyseSemantique {
  const brut = tokenize(texte.toLowerCase());
  const idx = index();

  // Négation : « ne »/« n' » suivi d'un marqueur, ou marqueur direct.
  const negation = brut.some((t, i) => {
    if (PREFIXES_NEGATION.test(t)) {
      const suivant = brut.slice(i + 1, i + 3).join(" ");
      return NEGATIONS.some((n) => suivant.startsWith(n));
    }
    return NEGATIONS.includes(t);
  });

  // Type de question (sur la phrase entière, pas les tokens).
  let question: TypeQuestion = "aucune";
  for (const [motif, type] of DETECTEURS_QUESTION) {
    if (motif.test(texte.trim())) {
      question = type;
      break;
    }
  }

  // Racines informatives (hors stopwords déjà filtrés par tokenize si
  // applicable — on refiltre par longueur minimale comme le cortex).
  const racines = [...new Set(brut.filter((t) => t.length >= 3).map(racineLegere))].filter(
    (r) => r.length >= 3,
  );

  // Expansion synonymique (1 niveau — borné).
  const racinesEtendues = new Set(racines);
  for (const r of racines) {
    for (const gi of idx.synonymesParMot.get(r) ?? []) {
      // Pas d'accès direct au groupe ici : l'expansion passe par l'index
      // des groupes — on ajoute les mots RACINISÉS des groupes partagés.
      racinesEtendues.add(`groupe:${gi}`); // marqueur de groupe partagé
    }
  }

  // Concepts enrichis par les relations du lexique.
  const concepts: AnalyseSemantique["concepts"] = [];
  const themes = new Set<string>();
  for (const r of racines) {
    const categories = [...(idx.categories.get(r) ?? [])];
    const instances = [...(idx.instances.get(r) ?? [])];
    const parties = [...(idx.parties.get(r) ?? [])];
    for (const c of categories) themes.add(c);
    // Une racine qui EST une catégorie du lexique est elle-même un thème
    // (parler de « véhicule » = parler du thème véhicule).
    if (idx.instances.has(r)) themes.add(r);
    if (categories.length || instances.length || parties.length || idx.synonymesParMot.has(r)) {
      concepts.push({ racine: r, categories, instances, parties });
    }
  }

  return {
    racines,
    racinesEtendues: [...racinesEtendues],
    negation,
    question,
    concepts,
    themes: [...themes],
  };
}

/**
 * SIMILARITÉ SÉMANTIQUE bornée [0, 1] entre deux textes.
 *
 * Score = mélange pondéré :
 *  - recouvrement lexical (jaccard des racines) — POIDS 0,5 ;
 *  - recouvrement RELATIONNEL (groupes de synonymes partagés, catégories
 *    communes, liens partie/tout) — POIDS 0,35 ;
 *  - cohérence thématique (thèmes partagés) — POIDS 0,15.
 *
 * PÉNALITÉ DE NÉGATION : si exactement une des deux phrases est niée et
 * qu'elles partagent du contenu, le score est rabattu (sémantiquement
 * opposées) — jamais au-dessus de 0,3.
 */
export function similariteSemantique(a: string, b: string): number {
  const ia = analyserSemantique(a);
  const ib = analyserSemantique(b);
  if (ia.racines.length === 0 || ib.racines.length === 0) return 0;

  // 1) Recouvrement lexical (jaccard racines).
  const ensembleA = new Set(ia.racines);
  const ensembleB = new Set(ib.racines);
  let inter = 0;
  for (const r of ensembleA) if (ensembleB.has(r)) inter += 1;
  const lexical = inter / (ensembleA.size + ensembleB.size - inter);

  // 2) Recouvrement relationnel : groupes de synonymes partagés.
  const groupesA = new Set(ia.racinesEtendues.filter((r) => r.startsWith("groupe:")));
  const groupesB = new Set(ib.racinesEtendues.filter((r) => r.startsWith("groupe:")));
  let groupesPartages = 0;
  for (const g of groupesA) if (groupesB.has(g)) groupesPartages += 1;
  const rapportGroupes = groupesPartages / Math.max(1, Math.min(groupesA.size, groupesB.size));

  // Liens catégoriels/meronymiques croisés : un concept de A est une
  // catégorie/partie d'un concept de B (ex. « chien » ↔ « animal »).
  const relationsA = new Set<string>();
  for (const c of ia.concepts) {
    for (const cat of c.categories) relationsA.add(`cat:${cat}`);
    for (const p of c.parties) relationsA.add(`partie:${p}`);
  }
  const racinesB = new Set(ib.racines);
  let liensCroises = 0;
  for (const rel of relationsA) {
    const cible = rel.includes(":") ? rel.slice(rel.indexOf(":") + 1) : rel;
    if (racinesB.has(cible)) liensCroises += 1;
  }
  const relationnel = Math.min(1, rapportGroupes * 0.7 + liensCroises * 0.35);

  // 3) Cohérence thématique.
  const themesA = new Set(ia.themes);
  const themesB = new Set(ib.themes);
  let themesPartages = 0;
  for (const t of themesA) if (themesB.has(t)) themesPartages += 1;
  const thematique = themesPartages > 0 ? 1 : 0;

  let score = lexical * 0.5 + relationnel * 0.35 + thematique * 0.15;

  // Identité de contenu : tout recouvrement lexical mutuel (mêmes racines
  // des deux côtés) = quasi-identité sémantique (même sens appris).
  if (ensembleA.size > 0 && ensembleA.size === ensembleB.size && inter === ensembleA.size) {
    score = Math.max(score, 0.97);
  }

  // Pénalité de négation (contenu partagé mais sens opposé).
  if (ia.negation !== ib.negation && (lexical > 0.3 || groupesPartages > 0)) {
    score = Math.min(score, 0.3);
  }

  // Garde bornée [0, 1].
  return Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;
}

/** Comparaison détaillée (pour traces et tests). */
export interface ComparaisonSemantique {
  score: number;
  lexical: number;
  negationOpposee: boolean;
  groupesSynonymesPartages: number;
  themesPartages: string[];
}

/** Version instrumentée de la similarité (utilisée par le laboratoire). */
export function comparerSemantique(a: string, b: string): ComparaisonSemantique {
  const ia = analyserSemantique(a);
  const ib = analyserSemantique(b);
  const groupesA = new Set(ia.racinesEtendues.filter((r) => r.startsWith("groupe:")));
  const groupesB = new Set(ib.racinesEtendues.filter((r) => r.startsWith("groupe:")));
  let groupesPartages = 0;
  for (const g of groupesA) if (groupesB.has(g)) groupesPartages += 1;
  const ensembleA = new Set(ia.racines);
  const ensembleB = new Set(ib.racines);
  let inter = 0;
  for (const r of ensembleA) if (ensembleB.has(r)) inter += 1;
  const lexical = inter / (ensembleA.size + ensembleB.size - inter);
  const themesPartages = ia.themes.filter((t) => ib.themes.includes(t));
  return {
    score: similariteSemantique(a, b),
    lexical,
    negationOpposee: ia.negation !== ib.negation,
    groupesSynonymesPartages: groupesPartages,
    themesPartages,
  };
}

/** Surface du module (métrique pour le laboratoire d'évaluation). */
export function surfaceSemantique(): { lexique: ReturnType<typeof tailleLexique>; negations: number; questions: number } {
  return { lexique: tailleLexique(), negations: NEGATIONS.length, questions: DETECTEURS_QUESTION.length };
}

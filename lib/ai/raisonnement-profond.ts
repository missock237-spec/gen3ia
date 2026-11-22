/**
 * RÉFLEXION PROFONDE DE GEN3 (demande produit 2026-11-22, trace 1a2022281ea8d0a5).
 *
 * Objectif : élever le niveau de réflexion de Gen3 vers un raisonnement de
 * type humain expert, et rendre la recherche web SYSTÉMATIQUE pour toute
 * tâche (compréhension approfondie de la demande avant d'agir), avec un
 * nombre de pages web réellement lues qui CROÎT avec la difficulté du
 * prompt (plancher absolu : 10 pages).
 *
 * Module PUR et DÉTERMINISTE (zéro LLM, zéro réseau) : il évalue la
 * difficulté, construit les requêtes de recherche, et produit les directives
 * de raisonnement injectées dans les prompts (planner universel, moteur
 * conversationnel, planification Task 42). Mêmes garde-fous que
 * tool-intent.ts : regex linéaires anti-ReDoS, scan borné aux 2000 premiers
 * caractères, aucune dépendance.
 */

/** Plancher ABSOLU de pages web réellement lues pour toute tâche (exigence produit : « 10 pages minimum »). */
export const MIN_PAGES_RECHERCHE = 10;

/** Plafond de pages (budget latence/coût par tâche). */
export const MAX_PAGES_RECHERCHE = 30;

/** Fenêtre de scan des prompts (miroir tool-intent.ts — anti-dilution, anti-ReDoS). */
const MAX_SCAN_LENGTH = 2000;

export type NiveauDifficulte = "simple" | "avancee" | "complexe" | "extreme";

export interface EvaluationDifficulte {
  /** Score déterministe 0..100 (longueur + marqueurs + questions + listes). */
  score: number;
  niveau: NiveauDifficulte;
  /** Pages web à lire réellement — TOUJOURS ≥ MIN_PAGES_RECHERCHE. */
  pagesRequises: number;
  /** Nombre de requêtes de recherche différenciées à mener. */
  requetesPrevues: number;
}

/** Marqueurs de difficulté (regex linéaires : classes quantifiées une fois, bornes \b uniquement). */
const MARQUEURS_DIFFICULTE: ReadonlyArray<{ pattern: RegExp; poids: number }> = [
  { pattern: /\b(compar(?:er|aison|atif\w*|ez)|audit|strat[ée]gie|benchmark|concurrents?)\b/iu, poids: 8 },
  { pattern: /\b(analys\w+|[ée]valu\w+|optimis\w+|diagnostic|mesure\w*)\b/iu, poids: 8 },
  { pattern: /\b(rapport|[ée]tude|dossier|pr[ée]sentation|slides?|pdf|docx|pptx|xlsx)\b/iu, poids: 7 },
  { pattern: /\b(workflow|automatis\w+|pipeline|int[ée]gr\w+|connecteur|webhook|api)\b/iu, poids: 9 },
  { pattern: /\b(r[ée]soudre|probl[èe]me complexe|d[ée]bog\w+|debug|corrige[rz]?)\b/iu, poids: 9 },
  { pattern: /\b(plan complet|de bout en bout|end-to-end|architecture|conception|d[ée]ploiement)\b/iu, poids: 10 },
  // NOTE : \b échoue devant un caractère accentué non-ASCII (« é » n'est pas
  // un mot ASCII) — les marqueurs accentués utilisent donc des garde-fous
  // unicode explicites (lookbehind/lookahead), comme tool-intent.ts.
  { pattern: /(?<![\p{L}\p{N}_])(?:[ée]tape[s]?|multi-[ée]tapes?|d'abord|ensuite|puis|enfin)(?![\p{L}\p{N}_])/iu, poids: 6 },
  { pattern: /\b(march[ée]|l[ée]gislation|r[ée]glementation|juridique|financier|technique\w*)\b/iu, poids: 6 },
];

/**
 * Évalue la difficulté d'un objectif de façon déterministe (zéro LLM).
 * La longueur du prompt pèse directement (exigence produit : « plus le
 * prompt est long, plus la recherche web doit avoir plusieurs pages »).
 */
export function evalueDifficulte(objective: string): EvaluationDifficulte {
  const text = objective.trim().slice(0, MAX_SCAN_LENGTH);
  let score = Math.min(25, Math.floor(text.length / 80));
  for (const marqueur of MARQUEURS_DIFFICULTE) {
    if (marqueur.pattern.test(text)) score += marqueur.poids;
  }
  const questions = (text.match(/\?/g) ?? []).length;
  score += Math.min(10, questions * 3);
  const listes = (text.match(/(^|\n)\s*([-*•]|\d+[.)])/g) ?? []).length;
  score += Math.min(12, listes * 3);
  score = Math.max(0, Math.min(100, score));

  const niveau: NiveauDifficulte = score >= 70 ? "extreme" : score >= 45 ? "complexe" : score >= 22 ? "avancee" : "simple";
  // Plancher 10 pages ABSOLU (exigence produit) ; croît avec la difficulté.
  const pagesRequises = Math.min(MAX_PAGES_RECHERCHE, Math.max(MIN_PAGES_RECHERCHE, MIN_PAGES_RECHERCHE + Math.round(score / 5)));
  const requetesPrevues = niveau === "extreme" ? 5 : niveau === "complexe" ? 4 : niveau === "avancee" ? 3 : 2;
  return { score, niveau, pagesRequises, requetesPrevues };
}

/* ------------------------------------------------------------------ */
/* Construction des requêtes de recherche différenciées                */
/* ------------------------------------------------------------------ */

const URL_RE = /https?:\/\/\S+/gu;

/** Cœur nettoyé d'un objectif (URLs retirées, espaces réduits, borné). */
function coeurObjectif(objective: string): string {
  return objective
    .replace(URL_RE, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
}

/**
 * Construit les requêtes de recherche différenciées pour comprendre la
 * demande sous plusieurs angles (déterministe, adapté au niveau).
 * La première requête est le cœur brut de la demande ; les suivantes
 * explorent explications, pièges, pratiques, comparaisons et actualité.
 */
export function construireRequetesRecherche(objective: string, evaluation: EvaluationDifficulte): string[] {
  const coeur = coeurObjectif(objective);
  if (!coeur) return [];
  const angles: Record<NiveauDifficulte, string[]> = {
    simple: [`${coeur} — explications claires`],
    avancee: [
      `${coeur} — explications détaillées`,
      `${coeur} — erreurs courantes et pièges à éviter`,
    ],
    complexe: [
      `${coeur} — explications détaillées`,
      `${coeur} — erreurs courantes et pièges à éviter`,
      `${coeur} — meilleures pratiques et exemples concrets`,
    ],
    extreme: [
      `${coeur} — explications détaillées`,
      `${coeur} — erreurs courantes et pièges à éviter`,
      `${coeur} — meilleures pratiques et exemples concrets`,
      `${coeur} — comparaison des solutions et alternatives`,
      `${coeur} — actualités et évolutions récentes`,
    ],
  };
  return [coeur, ...angles[evaluation.niveau]].slice(0, evaluation.requetesPrevues);
}

/* ------------------------------------------------------------------ */
/* Directives de réflexion profonde (injectées dans les prompts)        */
/* ------------------------------------------------------------------ */

const PHASES_REFLEXION = [
  "PHASE 1 — COMPRÉHENSION EXHAUSTIVE (silencieuse, avant toute réponse) : reformule la demande avec tes propres mots ; identifie l'intention VRAIE de l'utilisateur (ce qu'il veut obtenir, pas seulement ce qu'il dit) ; relève les contraintes implicites (délais, format, audience, niveau technique) ; liste ce qui n'est PAS précisé et doit être vérifié ou supposé explicitement.",
  "PHASE 2 — RÉFLEXION MULTI-ANGLES (pense comme un expert humain) : décompose le problème en sous-problèmes ; forme PLUSIEURS hypothèses ou solutions candidates (au moins deux) ; pour chacune, examine les avantages, les limites et les risques ; cherche des analogies avec des problèmes déjà résolus ; imagine les cas particuliers, les exceptions et ce qui pourrait mal tourner.",
  "PHASE 3 — VÉRIFICATION ET CONTRE-ARGUMENTATION : teste chaque hypothèse contre les FAITS réels (résultats de recherche web fournis, données vérifiables) ; cherche activement ce qui pourrait RÉFUTER ton idée initiale ; élimine les options faibles avec leur raison ; si une information nécessaire manque, effectue une recherche web au lieu d'inventer.",
  "PHASE 4 — SYNTHÈSE ARGUMENTÉE : rends une décision ou une réponse MOTIVÉE (pourquoi cette option plutôt qu'une autre) ; expose les étapes concrètes ou le raisonnement suivi ; mentionne ton niveau de confiance et les alternatives écartées ; ne conclus JAMAIS par une simple répétition de la question.",
] as const;

/** Version courte (niveau simple) : les 4 phases condensées en consignes compactes. */
const REFLEXION_COURTE = [
  "RÉFLEXION APPROFONDIE OBLIGATOIRE avant de répondre : 1) reformule silencieusement la demande et son intention vraie ; 2) envisage au moins deux angles ou solutions avant de choisir ; 3) vérifie tes conclusions contre les faits disponibles (jamais d'invention) ; 4) réponds de façon motivée et actionnable, pas générique.",
] as const;

/**
 * Directive de réflexion profonde graduée par difficulté : version courte
 * pour les demandes simples, déroulé complet des 4 phases pour l'avancé.
 */
export function directifReflexionProfonde(niveau: NiveauDifficulte): string {
  const intro = niveau === "extreme"
    ? "RÉFLEXION PROFONDE — MODE ÉTENDU (difficulté extrême) : raisonne comme un expert humain face à un problème difficile, en quatre phases explicites. Prends le temps d'explorer plusieurs pistes avant de trancher."
    : niveau === "complexe" || niveau === "avancee"
      ? "RÉFLEXION PROFONDE (difficulté élevée) : raisonne en quatre phases avant de produire ta réponse ou ton plan."
      : REFLEXION_COURTE[0];
  if (niveau === "simple") return intro;
  return [intro, ...PHASES_REFLEXION].join("\n");
}

/* ------------------------------------------------------------------ */
/* Détection de TÂCHE (recherche web systématique)                     */
/* ------------------------------------------------------------------ */

/**
 * Verbes d'action + marqueurs de tâche (regex linéaires, FR + EN) : leur
 * présence transforme un message en TÂCHE qui exige une recherche web
 * préalable de compréhension. Conçu pour NE PAS réagir aux salutations ni
 * aux noms communs (« remplissage » ne contient aucun de ces marqueurs).
 */
const MARQUEUR_TACHE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:cr[ée]\\p{L}*|g[éèe]n[éèe]r\\p{L}*|fais\\p{L}*|fabriqu\\p{L}*|r[ée]alis\\p{L}*|r[ée]dige?\\p{L}*|r[ée]dact\\p{L}*|analys\\p{L}*|[ée]valu\\p{L}*|compar\\p{L}*|trouv\\p{L}*|cherch\\p{L}*|recherch\\p{L}*|explor\\p{L}*|expliqu\\p{L}*|r[ée]sous?\\p{L}*|r[ée]soud\\p{L}*|corrige\\p{L}*|optimis\\p{L}*|construis\\p{L}*|concev\\p{L}*|d[ée]velopp\\p{L}*|planifi\\p{L}*|organis\\p{L}*|pr[ée]par\\p{L}*|produis\\p{L}*|converti\\p{L}*|convertis\\p{L}*|traduis\\p{L}*|r[ée]sum\\p{L}*|list\\p{L}*|montre[- ]moi|donne[- ]moi|aide[- ]moi [àa]|create|generate|write|build|design|research|analyze|compare|solve|fix|optimize|implement|explain(?![\\p{L}\\p{N}_]))`,
  "iu",
);

/** Salutations / acquittements purs : JAMAIS une tâche (contrat test tool-intent). */
const SMALL_TALK_RE = /^(?:bonjour|bonsoir|salut|coucou|hello|hi|hey|merci|au revoir|a\+|ok|d'accord|oui|non|super|parfait|top)[\s!.,?…]*$/iu;

/** Question substantielle : préfixe interrogatif + assez de matière pour chercher. */
const QUESTION_PREFIX_RE = /^(?:c[''’]est quoi|qu[''’]est[- ]ce|pourquoi|comment|qui (?:est|sont|était|sont)|o[ùu]|quand|quel(?:le|les)?|est[- ]ce que|what|why|how|who|where|which|should)/iu;

/**
 * Le message est-il une TÂCHE exigeant une recherche web systématique de
 * compréhension ? Déterministe : salutation pure → non ; message trop court
 * → non ; marqueur d'action OU question substantielle (≥ 60 caractères) → oui.
 */
export function estTacheRecherchable(message: string): boolean {
  const text = message.trim().slice(0, MAX_SCAN_LENGTH);
  if (text.length < 30 || SMALL_TALK_RE.test(text)) return false;
  if (MARQUEUR_TACHE_RE.test(text)) return true;
  return QUESTION_PREFIX_RE.test(text) && text.length >= 60;
}

/* ------------------------------------------------------------------ */
/* Section prompt combinée (recherche systématique + réflexion)         */
/* ------------------------------------------------------------------ */

/**
 * Section prompt complète injectée par le planner universel et le moteur de
 * conversation : directive de réflexion profonde graduée + exigence de
 * recherche web systématique multi-pages (plancher 10 pages) calibrée sur
 * la difficulté évaluée. Déterministe, borné en longueur.
 */
export function sectionReflexionEtRecherche(objective: string): string {
  const evaluation = evalueDifficulte(objective);
  return [
    directifReflexionProfonde(evaluation.niveau),
    "",
    `RECHERCHE WEB SYSTÉMATIQUE (impérative) : cette demande est une tâche de difficulté « ${evaluation.niveau} » (score ${evaluation.score}/100). AVANT de répondre ou de planifier, tu DOIS consulter le web pour comprendre le sujet en détail — au MINIMUM ${evaluation.pagesRequises} pages réellement lues (plancher 10 pages, davantage car la demande est ${evaluation.niveau === "extreme" ? "très complexe" : evaluation.niveau === "complexe" ? "complexe" : "détaillée"}), via web.deep_research (outil dédié qui interroge plusieurs requêtes et lit les pages réellement). Appuie-toi sur ces sources pour comprendre ce que l'utilisateur veut vraiment, vérifier les faits, et fonder ton raisonnement — ne réponds JAMAIS d'une tâche substantielle uniquement de mémoire.`,
  ].join("\n");
}

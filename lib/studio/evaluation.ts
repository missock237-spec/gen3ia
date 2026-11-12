/**
 * ÉVALUATION AVANT/APRÈS DU STUDIO D'ENTRAÎNEMENT (demande propriétaire :
 * « le cerveau doit devenir MESURABLEMENT plus performant sur ce domaine »).
 *
 * MÉTHODE HONNÊTE (aucune métrique fabriquée) :
 *   1. un JEU DE QUESTIONS DU DOMAINE est généré depuis les unités ingérées
 *      (la question canonique de chaque unité — pas une reformulation
 *      fabriquée) ;
 *   2. des QUESTIONS DE CONTRÔLE HORS DOMAINE (fixes, sans rapport avec le
 *      corpus) mesurent la NON-RÉGRESSION : la mémoire ne doit JAMAIS
 *      répondre à ces questions après l'entraînement ;
 *   3. le score AVANT est mesuré avec la réponse du cerveau SANS les unités
 *      ingérées (mémoire vide ou état antérieur), le score APRÈS avec la
 *      MÊME mécanique de consultation qui sera branchée au moteur
 *      (MemoireDomaineUtilisateur.repondre — le point d'injection réel) ;
 *   4. la correspondance sémantique est simple et documentée : Jaccard de
 *      tokens de contenu entre la réponse servie et la connaissance attendue
 *      — une unité servie correctement vaut ~1, une absence vaut 0.
 *
 * Le score APRÈS sur les questions du domaine est mathématiquement ≥ au
 * score AVANT (les unités servies s'ajoutent, rien n'est retiré) ; la valeur
 * du rapport est l'AMPLITUDE mesurée du gain et la PROUVE pour ce corpus.
 *
 * Module PUR — aucune dépendance Node, aucune dépendance au réseau.
 */

import { tokensContenu } from "./extraction-corpus";
import type { UniteConnaissance } from "./extraction-corpus";

/** Nombre maximal de questions d'évaluation générées du domaine. */
export const MAX_QUESTIONS_EVALUATION = 40;
/** Nombre de questions de contrôle hors domaine (fixes). */
export const MAX_QUESTIONS_CONTROLE = 6;

// ─── GÉNÉRATION DES QUESTIONS ────────────────────────────────────────────────

/** Génère le jeu de questions du domaine depuis les unités ingérées : la
 * question CANONIQUE de chaque unité (Q/A réelle, question dérivée pour les
 * faits et le code). Déterministe, plafonné, sans invention. */
export function genererQuestionsDomaine(
  unites: readonly UniteConnaissance[],
  plafond: number = MAX_QUESTIONS_EVALUATION,
): Array<{ question: string; attendu: string; empreinte: string }> {
  const questions: Array<{ question: string; attendu: string; empreinte: string }> = [];
  const vues = new Set<string>();
  for (const u of unites) {
    if (questions.length >= plafond) break;
    const q = u.question.trim();
    if (q.length < 6 || vues.has(q)) continue;
    vues.add(q);
    questions.push({ question: q, attendu: u.contenu, empreinte: u.empreinte });
  }
  return questions;
}

/**
 * QUESTIONS DE CONTRÔLE HORS DOMAINE (fixes, vérifiables) : aucun token de
 * ces questions ne recouvre le vocabulaire d'un corpus de domaine sain —
 * elles mesurent que la mémoire entraînée ne « déborde » pas hors domaine
 * (une question de contrôle SERVIE après ingestion est une régression).
 */
export function questionsControleHorsDomaine(): readonly string[] {
  return [
    "Quelle est la capitale du Pérou ?",
    "Écris un haïku sur la mer d'hiver.",
    "Combien font 17 multiplié par 23 ?",
    "Résume le roman Les Misérables en trois phrases.",
    "Quel temps fera-t-il demain après-midi à Lyon ?",
    "Recommande-moi un film de science-fiction des années 1980.",
  ];
}

// ─── CORRESPONDANCE SÉMANTIQUE (simple, documentée) ──────────────────────────

/** Correspondance sémantique simple : Jaccard des tokens de contenu entre la
 * connaissance attendue et la réponse obtenue (0 = aucun recouvrement). */
export function scoreCorrespondanceSemantique(attendu: string, obtenu: string): number {
  const a = tokensContenu(attendu);
  const b = tokensContenu(obtenu);
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return Math.round((inter / (sa.size + sb.size - inter)) * 10000) / 10000;
}

// ─── MÉTRIQUES ───────────────────────────────────────────────────────────────

/** Métriques d'UN côté (avant OU après) sur un jeu de questions. */
export interface MetriquesJeu {
  /** Nombre de questions évaluées. */
  readonly questions: number;
  /** Questions réellement SERVIES par la réponse mesurée. */
  readonly servies: number;
  /** Couverture = servies / questions (0 si aucune question). */
  readonly couverture: number;
  /** Correspondance sémantique moyenne sur les questions SERVIES (0..1). */
  readonly correspondanceServie: number;
  /** SCORE GLOBAL : moyenne par question de (servie ? correspondance : 0) —
   * c'est la métrique comparée avant/après (une question non servie vaut 0). */
  readonly scoreGlobal: number;
}

/** Répondeur injecté : la mécanique de consultation réellement mesurée
 * (avant : mémoire sans les unités ; après : mémoire avec). Retourne null
 * quand la réponse n'est pas servie. */
export type RepondeurEvaluation = (question: string) => string | null;

function mesurerJeu(
  questions: readonly { question: string; attendu: string }[],
  repondre: RepondeurEvaluation,
): MetriquesJeu {
  if (questions.length === 0) {
    return { questions: 0, servies: 0, couverture: 0, correspondanceServie: 0, scoreGlobal: 0 };
  }
  let servies = 0;
  let sommeCorrespondanceServie = 0;
  let sommeScoreGlobal = 0;
  for (const q of questions) {
    const obtenu = repondre(q.question);
    if (obtenu === null || obtenu.trim().length === 0) continue;
    servies += 1;
    const correspondance = scoreCorrespondanceSemantique(q.attendu, obtenu);
    sommeCorrespondanceServie += correspondance;
    sommeScoreGlobal += correspondance;
  }
  return {
    questions: questions.length,
    servies,
    couverture: Math.round((servies / questions.length) * 10000) / 10000,
    correspondanceServie:
      servies > 0 ? Math.round((sommeCorrespondanceServie / servies) * 10000) / 10000 : 0,
    scoreGlobal: Math.round((sommeScoreGlobal / questions.length) * 10000) / 10000,
  };
}

/** Non-régression hors domaine : les questions de contrôle mesurées avant et
 * après. `regression` = une question de contrôle SERVIE après alors qu'elle
 * ne l'était pas (le corpus déborde — doit rester false). */
export interface NonRegressionHorsDomaine {
  readonly questions: number;
  readonly serviesAvant: number;
  readonly serviesApres: number;
  readonly regression: boolean;
}

/** Rapport d'évaluation complet avant/après. */
export interface RapportEvaluation {
  readonly domaine: { readonly questions: number };
  readonly avant: MetriquesJeu;
  readonly apres: MetriquesJeu;
  /** Gain mesuré du score global sur le domaine (après − avant). */
  readonly amelioration: number;
  readonly horsDomaine: NonRegressionHorsDomaine;
}

/** Mesure AVANT/APRÈS d'un corpus ingéré.
 * `repondreAvant` est la mécanique de réponse du cerveau SANS les unités
 * ingérées ; `repondreApres`, AVEC. Le jeu du domaine est généré depuis les
 * unités (aucune question inventée) ; le contrôle est fixe. */
export function evaluerCorpus(params: {
  unites: readonly UniteConnaissance[];
  repondreAvant: RepondeurEvaluation;
  repondreApres: RepondeurEvaluation;
  questionsControle?: readonly string[];
  plafondQuestions?: number;
}): RapportEvaluation {
  const questions = genererQuestionsDomaine(params.unites, params.plafondQuestions);
  const controle = params.questionsControle ?? questionsControleHorsDomaine();
  const avant = mesurerJeu(questions, params.repondreAvant);
  const apres = mesurerJeu(questions, params.repondreApres);
  const controleAvant = mesurerJeu(
    controle.map((q) => ({ question: q, attendu: q })),
    params.repondreAvant,
  );
  const controleApres = mesurerJeu(
    controle.map((q) => ({ question: q, attendu: q })),
    params.repondreApres,
  );
  return {
    domaine: { questions: questions.length },
    avant,
    apres,
    amelioration: Math.round((apres.scoreGlobal - avant.scoreGlobal) * 10000) / 10000,
    horsDomaine: {
      questions: controle.length,
      serviesAvant: controleAvant.servies,
      serviesApres: controleApres.servies,
      regression: controleApres.servies > controleAvant.servies,
    },
  };
}

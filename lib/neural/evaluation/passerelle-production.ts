/**
 * PASSERELLE DE TESTS DE PRODUCTION — DÉVELOPPEMENT WEB + DNS (it.150).
 *
 * Demande propriétaire : « fonction prenant un "répondeur" async (question →
 * réponse) et exécutant les 10 tests de production → { tests: [{questionId,
 * score, verdict}], tauxAcquisition } — utilisée ensuite par une sonde Python
 * en production ».
 *
 * CONTRAT : le répondeur reçoit le PROMPT de chaque question de production
 * (IDs stables : QUESTIONS_TEST_PRODUCTION_DEV_WEB / IDS_TEST_PRODUCTION_
 * DEV_WEB) et renvoie sa réponse (chaîne ou promesse de chaîne). Le scoring
 * est celui de dev-web-eval.ts (grader lexical pondéré, déterministe).
 * HONNÊTETÉ : une réponse absente/ vide est scorée 0 (insuffisant) ; une
 * panne du répondeur est renvoyée telle quelle — la passerelle ne fabrique
 * aucun verdict.
 *
 * Module PUR — aucune dépendance Node.
 */

import {
  IDS_TEST_PRODUCTION_DEV_WEB,
  QUESTIONS_TEST_PRODUCTION_DEV_WEB,
  scorerReponseDevWeb,
  type VerdictDevWeb,
} from "./dev-web-eval";

/** Répondeur sous test : question (prompt) → réponse (synchrone ou async). */
export type RepondeurDevWeb = (question: string) => string | Promise<string>;

/** Résultat d'UN test de production. */
export interface ResultatTestProductionDevWeb {
  readonly questionId: string;
  readonly score: number;
  readonly verdict: VerdictDevWeb;
  /** Points clés non couverts (diagnostic rendu à la sonde). */
  readonly pointsManquants: readonly string[];
}

/** Rapport complet des 10 tests de production. */
export interface RapportTestsProductionDevWeb {
  readonly tests: readonly ResultatTestProductionDevWeb[];
  /** Part de tests « acquis » (0..1) — seuil de réussite global à convenir. */
  readonly tauxAcquisition: number;
  /** Part de tests au moins « partiel » (0..1) — mesure de tolérance. */
  readonly tauxPartielOuMieux: number;
  /** IDs exécutés (trace stable pour la sonde). */
  readonly ids: readonly string[];
}

/** Exécute les 10 tests de production contre le répondeur fourni.
 * Déterministe, séquentiel (un prompt à la fois), sans effet de bord. */
export async function executerTestsProductionDevWeb(
  repondeur: RepondeurDevWeb,
): Promise<RapportTestsProductionDevWeb> {
  const tests: ResultatTestProductionDevWeb[] = [];
  let acquis = 0;
  let partielOuMieux = 0;
  for (const question of QUESTIONS_TEST_PRODUCTION_DEV_WEB) {
    const brut = await repondeur(question.prompt);
    const scoring = scorerReponseDevWeb(question.id, brut ?? "");
    if (scoring.verdict === "acquis") acquis += 1;
    if (scoring.verdict === "acquis" || scoring.verdict === "partiel") partielOuMieux += 1;
    tests.push({
      questionId: question.id,
      score: scoring.score0a100,
      verdict: scoring.verdict,
      pointsManquants: scoring.pointsManquants,
    });
  }
  return {
    tests,
    tauxAcquisition: tests.length === 0 ? 0 : acquis / tests.length,
    tauxPartielOuMieux: tests.length === 0 ? 0 : partielOuMieux / tests.length,
    ids: IDS_TEST_PRODUCTION_DEV_WEB,
  };
}

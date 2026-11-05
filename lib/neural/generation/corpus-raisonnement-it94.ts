/**
 * CORPUS RAISONNEMENT it.94 — dérivé du générateur déterministe
 * (lib/gen3/raisonnement-it94.ts, 7 familles de raisonnement à couverture
 * zéro mesurée : deduction, conditionnel, spatial, temporel, analogie,
 * causalite, planification — cf. var-copie/progression.json).
 *
 * - CORPUS_RAISONNEMENT_IT94 : 140 paires (20 par famille, graine 42) servies
 *   par le chat (module PUR, aucune dépendance Node) ;
 * - CORPUS_RAISONNEMENT_IT94_EVAL : 70 paires RÉSERVÉES (10 par famille,
 *   graine 20261105) — JAMAIS entraînées, uniquement pour la mesure
 *   avant/après de la gravure SNN (honnêteté de la vérification).
 */

import type { PaireLangage } from "./corpus";
import { genererRaisonnementIt94 } from "../../gen3/raisonnement-it94";

/** Paire chat (motif serviable par le cortex langagier). */
export type PaireEvalIt94 = PaireLangage & { readonly fond: string };

function versPaires(graine: number, parFamille: number, modeEval = false): readonly PaireLangage[] {
  return genererRaisonnementIt94(parFamille, graine, modeEval).map((p) => ({
    motif: p.motif,
    reponse: p.reponse,
    theme: p.theme,
  }));
}

function versPairesEval(graine: number, parFamille: number): readonly PaireEvalIt94[] {
  return genererRaisonnementIt94(parFamille, graine, true).map((p) => ({
    motif: p.motif,
    reponse: p.reponse,
    theme: p.theme,
    fond: p.fond,
  }));
}

export const CORPUS_RAISONNEMENT_IT94: readonly PaireLangage[] =
  versPaires(42, 20);

/** Réservé à la mesure SNN (formulations inédites, jamais servies au chat). */
export const CORPUS_RAISONNEMENT_IT94_EVAL: readonly PaireEvalIt94[] =
  versPairesEval(20261105, 10);

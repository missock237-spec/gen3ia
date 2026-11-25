/**
 * AUTONOMOUS EVALUATOR (UCE-006) — agrégateur d'évaluation : combine
 * compatibilité (mesurée), sécurité (registres réels), qualité (faits) et
 * benchmark (sandbox réelle) en un score unique pondéré + un verdict.
 *
 * Règle mission §2.C : « le moteur ne doit jamais considérer qu'un outil est
 * performant simplement parce que sa documentation le prétend » — sans
 * benchmark réel, fonctionnementReel = 0 et le verdict ne peut pas être
 * « recommandé ». Le comparateur produit un classement par mesures.
 */

import "server-only";

import type {
  CapabilityEvaluation,
  EvaluationCriteria,
} from "../core/capability-contract";
import { maintenantIso } from "../core/capability-contract";
import { sauvegarder, nouvelId } from "../storage/capability-repository";
import { evaluerQualite, type ScoresQualite } from "./quality-evaluator";
import { evaluerSecuriteLocale, evaluerSecuriteRegistre, type ScoresSecurite } from "./security-evaluator";
import type { RapportCompatibilite } from "./compatibility-engine";
import type { BenchmarkStats } from "../core/capability-contract";

/** Poids des critères (somme = 100). Le fonctionnement réel domine. */
export const POIDS_CRITERES: Record<keyof EvaluationCriteria, number> = {
  fonctionnementReel: 30,
  compatibiliteGen3ia: 15,
  performance: 12,
  precision: 8,
  fiabilite: 10,
  securite: 15,
  memoire: 3,
  cpu: 2,
  cout: 2,
  maintenabilite: 2,
  documentation: 1,
};

export interface EntreesEvaluation {
  capabilityId: string;
  compatibilite: RapportCompatibilite;
  securite: ScoresSecurite;
  qualite: ScoresQualite;
  /** Benchmark réel — absent ⇒ fonctionnementReel forcé à 0. */
  benchmark?: BenchmarkStats;
}

/** Calcule chaque critère depuis des mesures (jamais de la documentation). */
export function critèresDepuisMesures(entrees: EntreesEvaluation): EvaluationCriteria {
  const { compatibilite, securite, qualite, benchmark } = entrees;

  // Fonctionnement réel : UNIQUEMENT si un benchmark a tourné.
  const fonctionnementReel = benchmark ? Math.round(benchmark.tauxSucces * 100) : 0;

  const compatibiliteGen3ia =
    compatibilite.verdict === "compatible" ? 100 : compatibilite.verdict === "risque" ? 55 : 0;

  // Performance : relative à une latence cible 200 ms (bornée).
  const performance = benchmark
    ? Math.max(0, Math.min(100, Math.round((200 / Math.max(1, benchmark.latenceMoyenneMs)) * 100)))
    : 0;

  // Précision : pas mesurable génériquement → 100 si ok observé, sinon 0.
  const precision = benchmark && benchmark.succes > 0 ? 100 : 0;

  // Fiabilité : taux de succès des runs.
  const fiabilite = benchmark ? Math.round(benchmark.tauxSucces * 100) : 0;

  // Ressources : mémoire observée vs budget 256 Mo de la sandbox UCE.
  const memoire = benchmark?.memoirePicMo ? Math.max(0, Math.min(100, Math.round((256 / Math.max(1, benchmark.memoirePicMo)) * 100))) : 60;
  const cpu = benchmark ? Math.min(100, Math.max(0, Math.round((3000 / Math.max(1, benchmark.latenceMoyenneMs)) * 100))) : 50;

  // Coût : gratuit → 100 (mission : pas de dépendance payante obligatoire).
  const cout = 100;

  return {
    fonctionnementReel,
    compatibiliteGen3ia,
    performance,
    precision,
    fiabilite,
    securite: securite.total,
    memoire,
    cpu,
    cout,
    maintenabilite: qualite.maintenabilite,
    documentation: qualite.documentation,
  };
}

export function scoreAgregue(criteria: EvaluationCriteria): number {
  let total = 0;
  for (const [cle, poids] of Object.entries(POIDS_CRITERES)) {
    total += (criteria[cle as keyof EvaluationCriteria] ?? 0) * (poids / 100);
  }
  return Math.round(total);
}

export function verdictDepuisScore(score: number, criteria: EvaluationCriteria): CapabilityEvaluation["verdict"] {
  if (score >= 65 && criteria.fonctionnementReel >= 80 && criteria.securite >= 60) return "recommande";
  if (score >= 40) return "revue_requise";
  return "rejete";
}

/**
 * Évalue une candidate complète (compatibilité + sécurité + qualité + benchmark
 * déjà mesurés par les moteurs spécialisés) et persiste l'évaluation.
 */
export async function evaluerAutonome(entrees: EntreesEvaluation, options: { dossier?: string; persister?: boolean } = {}): Promise<CapabilityEvaluation> {
  const criteria = critèresDepuisMesures(entrees);
  const score = scoreAgregue(criteria);
  const verdict = verdictDepuisScore(score, criteria);
  const raisons: string[] = [];

  raisons.push(`compatibilité : ${entrees.compatibilite.verdict} (${entrees.compatibilite.controles.filter((c) => !c.ok).length} contrôle(s) non ok)`);
  raisons.push(`sécurité : ${entrees.securite.verdict} (score ${entrees.securite.total})`);
  raisons.push(`qualité : total ${entrees.qualite.total}/100, ${entrees.qualite.constats.length} constat(s)`);
  raisons.push(entrees.benchmark
    ? `benchmark réel : ${Math.round(entrees.benchmark.tauxSucces * 100)}% succès, latence moy. ${entrees.benchmark.latenceMoyenneMs} ms`
    : "AUCUN benchmark réel : fonctionnement réel crédité 0 (règle anti-documentation) — benchmark obligatoire avant recommandation");
  if (verdict === "rejete" && !entrees.benchmark) raisons.push("verdict « rejete » conservateur : aucune mesure disponible");

  const evaluation: CapabilityEvaluation = {
    id: nouvelId("eval", entrees.capabilityId),
    capabilityId: entrees.capabilityId,
    criteria,
    score,
    verdict,
    raisons,
    mesureReelle: Boolean(entrees.benchmark),
    evalueLe: maintenantIso(),
    schemaVersion: 1,
  };

  if (options.persister !== false) {
    try {
      await sauvegarder("evaluations", evaluation, { dossier: options.dossier });
    } catch {
      // non fatal : l'évaluation reste retournée
    }
  }
  return evaluation;
}

// Réexports (convention du dépôt : surfaces uniques d'import).
export { evaluerQualite, evaluerSecuriteLocale, evaluerSecuriteRegistre };

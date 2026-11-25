/**
 * CAPABILITY IMPROVEMENT PLANNER (UCE V1.1 Phase 6) — transforme les
 * insuffisances détectées (gap-analyzer) en PLANS D'AMÉLIORATION complets
 * (mission §Phase 6) : objectif, étapes, dépendances, coût estimé,
 * ressources requises, niveau de risque, tests nécessaires, critères de
 * réussite, stratégie de retour arrière.
 *
 * RÈGLE D'AUTORITÉ : le planificateur NE prend PAS de décision stratégique
 * — il prépare des plans ; le CERVEAU CENTRAL choisit le plan final
 * (`choisirPlan`, gated par la politique d'autonomie). Un plan n'est jamais
 * exécuté par lui-même : il est exécuté par l'orchestrateur du cycle.
 */

import "server-only";

import { maintenantIso } from "../core/capability-contract";
import { nouvelId, sauvegarder, recuperer, lister, type RepositoryUceOptions } from "../storage/capability-repository";
import { evaluerAction, type ActionCapacite } from "./autonomy-policy-engine";
import type { InsuffisanceCapacite } from "./capability-gap-analyzer";

export const ACTIONS_PLAN = [
  "reutiliser",
  "adapter",
  "decouvrir-bibliotheque",
  "decouvrir-api",
  "decouvrir-modele",
  "generer-competence",
  "construire-outil",
  "optimiser",
  "remplacer",
] as const;
export type ActionPlan = (typeof ACTIONS_PLAN)[number];

export interface EtapePlan {
  nom: string;
  description: string;
  /** Moteur UCE exécutant l'étape (worker — jamais un décideur). */
  moteur: string;
}

export interface PlanAmelioration {
  id: string;
  insuffisanceId: string;
  /** Décision du cerveau rattachée (si déjà produite). */
  decisionId?: string;
  objectif: string;
  action: ActionPlan;
  etapes: EtapePlan[];
  dependances: string[];
  coutEstime: string;
  ressourcesRequises: string[];
  niveauRisque: "faible" | "moyen" | "eleve";
  testsNecessaires: string[];
  criteresReussite: string[];
  strategieRetourArriere: string;
  /** proposer → choisi (par le cerveau) → execute | rejete. */
  statut: "propose" | "choisi" | "execute" | "rejete";
  /** Verdict de la politique d'autonomie (calculé réellement). */
  verdictPolitique: { autorise: boolean; approbationRequise: boolean; raison: string };
  creeLe: string;
  schemaVersion: number;
}

/** Carte catégorie d'insuffisance → action de plan (règles explicites). */
const ACTION_PAR_CATEGORIE: Record<InsuffisanceCapacite["categorie"], ActionPlan> = {
  "fonctionnalite-absente": "decouvrir-bibliotheque",
  "outil-defaillant": "remplacer",
  "outil-lent": "optimiser",
  "outil-couteux": "decouvrir-bibliotheque",
  "fiabilite-insuffisante": "optimiser",
  "amelioration-possible": "optimiser",
};

const ETAPES_PAR_ACTION: Record<ActionPlan, EtapePlan[]> = {
  reutiliser: [
    { nom: "vérifier la couverture réelle", description: "exécuter la capacité existante sur les cas d'usage visés (gateway, traces réelles)", moteur: "universal-gateway" },
    { nom: "documenter la réutilisation", description: "fiche de la capacité pointée comme solution du besoin", moteur: "documentation-generator" },
  ],
  adapter: [
    { nom: "modifier l'adaptateur", description: "ajuster l'adaptateur d'exécution (entrées/sorties) sans toucher au cœur", moteur: "builder" },
    { nom: "tester en sandbox", description: "benchmark avant/après sur le même scénario", moteur: "benchmark-engine" },
  ],
  "decouvrir-bibliotheque": [
    { nom: "découverte multi-sources", description: "npm/PyPI/HF/MCP/APIs — fiches normalisées", moteur: "universal-discovery" },
    { nom: "compatibilité + sécurité", description: "16 contrôles mesurés + supply-chain", moteur: "compatibility-engine" },
    { nom: "benchmark comparatif", description: "≥ 3 candidates mesurées en sandbox, tri sur mesures", moteur: "benchmark-engine" },
  ],
  "decouvrir-api": [
    { nom: "découverte d'APIs", description: "catalogue daté + vérification live (SSRF-gated)", moteur: "api-discovery" },
    { nom: "évaluation + benchmark", description: "score pondéré + mesures réelles", moteur: "autonomous-evaluator" },
  ],
  "decouvrir-modele": [
    { nom: "découverte de modèles", description: "métadonnées HF réelles", moteur: "model-discovery" },
    { nom: "compatibilité matérielle", description: "GPU/mémoire mesurés (verdict honnête)", moteur: "compatibility-engine" },
  ],
  "generer-competence": [
    { nom: "génération sandbox", description: "skill générée et validée par exercice réel (échec = non-acquis)", moteur: "skill-generator" },
    { nom: "validation d'apprentissage", description: "mesure avant/après sur jeu de test indépendant", moteur: "learning-validator" },
  ],
  "construire-outil": [
    { nom: "construction 10 étapes", description: "outil généré déterministe, sortie max « proposée »", moteur: "tool-builder" },
    { nom: "tests sandbox", description: "jeux d'essai succès/refus exécutés réellement", moteur: "benchmark-engine" },
  ],
  optimiser: [
    { nom: "profil des causes", description: "catégorisation des échecs/lenteurs mesurées", moteur: "failure-analyzer" },
    { nom: "modification bornée", description: "optimisation de l'adaptateur/paramètres, jamais du cœur", moteur: "builder" },
    { nom: "comparaison avant/après", description: "mêmes benchmarks, détection de régression (garde −0.02)", moteur: "benchmark-engine" },
  ],
  remplacer: [
    { nom: "candidates de remplacement", description: "découverte + évaluation de ≥ 2 alternatives", moteur: "universal-discovery" },
    { nom: "version candidate", description: "publication append-only + tests de non-régression", moteur: "version-manager" },
    { nom: "rollback prêt", description: "retour à la version stable documenté avant tout basculement", moteur: "rollback-manager" },
  ],
};

const RISQUE_PAR_ACTION: Record<ActionPlan, PlanAmelioration["niveauRisque"]> = {
  reutiliser: "faible",
  adapter: "faible",
  "decouvrir-bibliotheque": "faible",
  "decouvrir-api": "faible",
  "decouvrir-modele": "moyen",
  "generer-competence": "moyen",
  "construire-outil": "moyen",
  optimiser: "moyen",
  remplacer: "eleve",
};

/** Élabore UN plan complet pour une insuffisance (règles déterministes). */
export function elaborerPlan(insuffisance: InsuffisanceCapacite): Omit<PlanAmelioration, "id" | "creeLe" | "schemaVersion" | "verdictPolitique" | "statut" | "decisionId"> {
  const action = ACTION_PAR_CATEGORIE[insuffisance.categorie];
  const risque = RISQUE_PAR_ACTION[action];
  return {
    insuffisanceId: insuffisance.id,
    objectif: insuffisance.objectifMesurable || insuffisance.description,
    action,
    etapes: ETAPES_PAR_ACTION[action],
    dependances: insuffisance.capabilityId ? [insuffisance.capabilityId] : [],
    coutEstime: "gratuit (sandbox local + registres publics lecture seule)",
    ressourcesRequises: [insuffisance.ressourcesEstimees, risque === "eleve" ? "autorisation humaine obligatoire (remplacement en production)" : "sandbox isolée 2 CPU / RAM bornée"],
    niveauRisque: risque,
    testsNecessaires: [
      "benchmark sandbox reproductible (≥ 3 runs)",
      "tests de non-régression sur la version stable",
      ...(risque === "eleve" ? ["validation d'intégration complète via le gateway"] : []),
    ],
    criteresReussite: [insuffisance.objectifMesurable, "aucune régression détectée (garde −0.02)", "vérification indépendante du résultat avant confirmation"],
    strategieRetourArriere:
      action === "remplacer"
        ? "version stable conservée ; rollback effectuerRollback (traçable cap_rollbacks) immédiatement disponible"
        : "aucun effet de production : tout reste en sandbox jusqu'à l'autorisation ; restauration = abandon du plan",
  };
}

/**
 * Produit et persiste les plans pour les insuffisances données. Chaque plan
 * porte le VERDICT RÉEL de la politique d'autonomie (aucun contournement).
 */
export async function elaborerPlans(insuffisances: InsuffisanceCapacite[], options: RepositoryUceOptions = {}, decisionId?: string): Promise<PlanAmelioration[]> {
  const plans: PlanAmelioration[] = [];
  for (const insuffisance of insuffisances.slice(0, 10)) {
    const base = elaborerPlan(insuffisance);
    const verdict = await evaluerAction(
      {
        action: (base.action === "remplacer" ? "replace" : base.action === "construire-outil" || base.action === "generer-competence" ? "build" : base.action === "optimiser" || base.action === "adapter" ? "improve" : "discover") as ActionCapacite,
        cible: insuffisance.capabilityId,
        risqueFaible: base.niveauRisque === "faible",
        politiqueApprouvee: false,
      },
      options,
    );
    const plan: PlanAmelioration = {
      ...base,
      id: nouvelId("plan", `${base.action}:${insuffisance.id}`),
      decisionId,
      verdictPolitique: { autorise: verdict.autorise, approbationRequise: verdict.approbationRequise, raison: verdict.raison },
      statut: "propose",
      creeLe: maintenantIso(),
      schemaVersion: 1,
    };
    try {
      await sauvegarder("plans", plan, options);
    } catch {
      // persistance indisponible : le plan reste retourné honnêtement
    }
    plans.push(plan);
  }
  return plans;
}

/**
 * LE CERVEAU CENTRAL choisit le plan final (mission §Phase 6) — jamais le
 * planificateur. Le choix exige : plan autorisé par la politique et une
 * référence de décision/autorité explicite.
 */
export async function choisirPlan(planId: string, params: { par: string; decisionId?: string }, options: RepositoryUceOptions = {}): Promise<{ ok: boolean; plan?: PlanAmelioration; raison: string }> {
  if (!params.par?.trim() || params.par.trim().length < 4) {
    return { ok: false, raison: "choix de plan refusé : autorité explicite requise (le planificateur ne décide pas seul)" };
  }
  const plan = await recuperer<PlanAmelioration>("plans", planId, options);
  if (!plan) return { ok: false, raison: `plan inconnu : ${planId}` };
  if (!plan.verdictPolitique.autorise) {
    return { ok: false, raison: `plan refusé par la politique d'autonomie : ${plan.verdictPolitique.raison}` };
  }
  plan.statut = "choisi";
  if (params.decisionId) plan.decisionId = params.decisionId;
  await sauvegarder("plans", plan, options);
  return { ok: true, plan, raison: `plan ${planId} choisi (action ${plan.action}, risque ${plan.niveauRisque}) — exécution par l'orchestrateur` };
}

/** Plans récents (dashboard + orchestrateur). */
export async function plansRecents(options: RepositoryUceOptions = {}, limite = 50): Promise<PlanAmelioration[]> {
  return lister<PlanAmelioration>("plans", undefined, limite, options);
}

/** Marque un plan exécuté (preuve de l'orchestrateur) ou rejeté. */
export async function marquerPlan(planId: string, statut: "execute" | "rejete", options: RepositoryUceOptions = {}): Promise<{ ok: boolean; raison: string }> {
  const plan = await recuperer<PlanAmelioration>("plans", planId, options);
  if (!plan) return { ok: false, raison: `plan inconnu : ${planId}` };
  plan.statut = statut;
  await sauvegarder("plans", plan, options);
  return { ok: true, raison: `plan ${planId} → ${statut}` };
}

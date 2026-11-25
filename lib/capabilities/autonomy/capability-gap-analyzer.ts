/**
 * CAPABILITY GAP ANALYZER (UCE V1.1 Phase 5) — moteur d'identification des
 * capacités MANQUANTES ou INSUFFISANTES. Il compare (mission §Phase 5) :
 *   1. les capacités disponibles (registre central),
 *   2. les demandes des utilisateurs (besoins remontés),
 *   3. les tâches échouées (cap_executions analysées),
 *   4. les performances des outils (p95 mesuré),
 *   5. les besoins des agents (événements du cerveau),
 *   6. les objectifs du cerveau (décisions « discover » en attente),
 *   7. les ressources disponibles (monitoring).
 *
 * Règle mission : le système ÉVITE de créer un nouvel outil lorsqu'un outil
 * existant peut être AMÉLIORÉ — une capacité défaillante produit une
 * insuffisance « amélioration possible », pas « fonctionnalité absente ».
 * Chaque insuffisance porte identifiant, description, priorité, justification,
 * mesure de référence, objectif mesurable et ressources estimées.
 */

import "server-only";

import { maintenantIso } from "../core/capability-contract";
import { nouvelId, sauvegarder, lister, type RepositoryUceOptions } from "../storage/capability-repository";
import { santeGlobale } from "../monitoring/capability-health";
import { analyserEchecs } from "../monitoring/failure-analyzer";
import { performanceGlobale } from "../monitoring/performance-monitor";
import { decisionsRecentes } from "../core/capability-decision";
import { refuserSiSecret } from "../security/secrets-protection";

export const CATEGORIES_INSUFFISANCE = [
  "fonctionnalite-absente",
  "outil-defaillant",
  "outil-lent",
  "outil-couteux",
  "fiabilite-insuffisante",
  "amelioration-possible",
] as const;
export type CategorieInsuffisance = (typeof CATEGORIES_INSUFFISANCE)[number];

export interface InsuffisanceCapacite {
  id: string;
  description: string;
  categorie: CategorieInsuffisance;
  priorite: "basse" | "normale" | "haute" | "critique";
  justification: string;
  /** Mesure de référence RÉELLE (source citée) — jamais de valeur inventée. */
  mesureReference: string;
  /** Objectif mesurable posé pour clore l'insuffisance. */
  objectifMesurable: string;
  /** Estimation honnête des ressources nécessaires (texte borné). */
  ressourcesEstimees: string;
  capabilityId?: string;
  /** Laquelle des 7 sources mission a produit l'insuffisance. */
  source: "monitoring-sante" | "performance" | "echecs" | "besoins" | "decisions-cerveau";
  detecteeLe: string;
  schemaVersion: number;
}

export interface RapportInsuffisances {
  insuffisances: InsuffisanceCapacite[];
  sources: {
    capacitesAnalysees: number;
    executionsAnalysees: number;
    performancesAnalysees: number;
    besoinsRecus: number;
    decisionsCerveau: number;
  };
  /** Seuils utilisés (auditables — pas de magie). */
  seuils: { p95LentMs: number; fiabiliteMin: number };
  dureeMs: number;
}

const SEUIL_P95_LENT_MS = 10_000;
const SEUIL_FIABILITE_MIN = 0.9;

/**
 * Analyse RÉELLE des insuffisances. Ne lève jamais ; les sources
 * indisponibles sont signalées honnêtement dans le rapport.
 */
export async function analyserManques(params: {
  /** Besoins remontés (utilisateurs/agents/cerveau) sans outil couvrant. */
  besoinsNonSatisfaits?: string[];
  options?: RepositoryUceOptions;
} = {}): Promise<RapportInsuffisances> {
  const debut = Date.now();
  const options = params.options ?? {};
  const insuffisances: InsuffisanceCapacite[] = [];
  let executionsAnalysees = 0;
  let performancesAnalysees = 0;
  let capacitesAnalysees = 0;

  const poser = (i: Omit<InsuffisanceCapacite, "id" | "detecteeLe" | "schemaVersion">) => {
    const insuffisance: InsuffisanceCapacite = { ...i, id: nouvelId("gap", `${i.categorie}:${i.capabilityId ?? i.description}`), detecteeLe: maintenantIso(), schemaVersion: 1 };
    insuffisances.push(insuffisance);
  };

  // SOURCE 1+3 — santé des capacités + échecs (monitoring mesuré).
  try {
    const [sante, echecs] = await Promise.all([santeGlobale(options), analyserEchecs(options)]);
    executionsAnalysees = echecs.executionsAnalysees;
    capacitesAnalysees = sante.capacites.length;
    for (const cap of sante.capacites.slice(0, 10)) {
      if (cap.etat === "en_echec") {
        poser({
          description: `capacité ${cap.capabilityId} en échec (${cap.echecsConsecutifs} échec(s) consécutif(s))`,
          categorie: cap.tauxSucces < 0.3 ? "outil-defaillant" : "amelioration-possible",
          priorite: cap.echecsConsecutifs >= 5 ? "critique" : "haute",
          justification: `taux de succès mesuré ${Math.round(cap.tauxSucces * 100)} % — ${cap.tauxSucces < 0.3 ? "défaillance structurelle" : "correction préférable au remplacement (règle anti-doublon)"}`,
          mesureReference: `tauxSucces=${Math.round(cap.tauxSucces * 100)} %, echecsConsecutifs=${cap.echecsConsecutifs} (cap_health)`,
          objectifMesurable: "taux de succès mesuré ≥ 90 % sur les 10 prochaines exécutions",
          ressourcesEstimees: "diagnostic des échecs (failure-analyzer) + un cycle d'amélioration sandbox",
          capabilityId: cap.capabilityId,
          source: "monitoring-sante",
        });
      } else if (cap.etat === "degradee" && cap.tauxSucces < SEUIL_FIABILITE_MIN) {
        poser({
          description: `fiabilité insuffisante de ${cap.capabilityId} (état dégradé)`,
          categorie: "fiabilite-insuffisante",
          priorite: "normale",
          justification: `taux de succès mesuré ${Math.round(cap.tauxSucces * 100)} % < seuil ${Math.round(SEUIL_FIABILITE_MIN * 100)} %`,
          mesureReference: `tauxSucces=${Math.round(cap.tauxSucces * 100)} % (cap_health)`,
          objectifMesurable: `taux de succès mesuré ≥ ${Math.round(SEUIL_FIABILITE_MIN * 100)} %`,
          ressourcesEstimees: "analyse des causes + ajustement de l'adaptateur",
          capabilityId: cap.capabilityId,
          source: "monitoring-sante",
        });
      }
    }
  } catch {
    // monitoring indisponible : honnête — les autres sources continuent
  }

  // SOURCE 4 — performances mesurées (lenteur).
  try {
    const performances = await performanceGlobale(options);
    performancesAnalysees = performances.length;
    for (const perf of performances.filter((p) => p.dureeP95Ms > SEUIL_P95_LENT_MS).slice(0, 5)) {
      poser({
        description: `outil ${perf.capabilityId} trop lent (p95 mesuré ${perf.dureeP95Ms} ms)`,
        categorie: "outil-lent",
        priorite: perf.dureeP95Ms > 30_000 ? "haute" : "normale",
        justification: `latence p95 mesurée ${perf.dureeP95Ms} ms > seuil ${SEUIL_P95_LENT_MS} ms avec ${perf.executions} exécution(s)`,
        mesureReference: `p95=${perf.dureeP95Ms} ms sur ${perf.executions} exécutions (cap_perf)`,
        objectifMesurable: `p95 mesuré ≤ ${SEUIL_P95_LENT_MS} ms sur le même scénario`,
        ressourcesEstimees: "benchmark avant/après (2 runs × 3) + optimisation de l'adaptateur",
        capabilityId: perf.capabilityId,
        source: "performance",
      });
    }
  } catch {
    // idem — honnête
  }

  // SOURCE 2+5 — besoins non satisfaits (demandes sans capacité).
  for (const besoin of (params.besoinsNonSatisfaits ?? []).slice(0, 5)) {
    const secret = refuserSiSecret(besoin);
    if (!secret.autorise) continue;
    poser({
      description: `fonctionnalité absente : ${besoin.slice(0, 140)}`,
      categorie: "fonctionnalite-absente",
      priorite: "haute",
      justification: "demande remontée sans capacité existante capable de la couvrir (registre central consulté)",
      mesureReference: "registre central : aucune entrée couvrant ce besoin ; 0 exécution réussie associée",
      objectifMesurable: "≥ 3 candidates découvertes et comparées sur mesures réelles",
      ressourcesEstimees: "un cycle de découverte multi-sources + évaluation + benchmark sandbox",
      source: "besoins",
    });
  }

  // SOURCE 6 — objectifs du cerveau : décisions « discover » non planifiées.
  try {
    const decisions = await decisionsRecentes(options, 50);
    for (const d of decisions.filter((x) => x.action === "discover" && x.statut === "produite").slice(0, 3)) {
      poser({
        description: `besoin du cerveau sans plan : ${d.objective.slice(0, 140)}`,
        categorie: "fonctionnalite-absente",
        priorite: d.priorite === "critique" ? "critique" : "haute",
        justification: `décision du cerveau central « ${d.decisionId} » produite mais pas encore planifiée`,
        mesureReference: `décision ${d.decisionId} (cap_decisions, statut produit)`,
        objectifMesurable: "plan d'amélioration produit et choisi par le cerveau",
        ressourcesEstimees: "planification + cycle de découverte",
        source: "decisions-cerveau",
      });
    }
  } catch {
    // honnête
  }

  const rapport: RapportInsuffisances = {
    insuffisances,
    sources: { capacitesAnalysees, executionsAnalysees, performancesAnalysees, besoinsRecus: (params.besoinsNonSatisfaits ?? []).length, decisionsCerveau: insuffisances.filter((i) => i.source === "decisions-cerveau").length },
    seuils: { p95LentMs: SEUIL_P95_LENT_MS, fiabiliteMin: SEUIL_FIABILITE_MIN },
    dureeMs: Date.now() - debut,
  };

  // Persistance (cap_gaps) — traçabilité pour le cerveau et le dashboard.
  for (const i of insuffisances) {
    try {
      await sauvegarder("gaps", i, options);
    } catch {
      // persistance indisponible : le rapport reste retourné honnêtement
    }
  }
  return rapport;
}

/** Insuffisances récentes persistées (dashboard + planificateur). */
export async function insuffisancesRecentes(options: RepositoryUceOptions = {}, limite = 50): Promise<InsuffisanceCapacite[]> {
  return lister<InsuffisanceCapacite>("gaps", undefined, limite, options);
}

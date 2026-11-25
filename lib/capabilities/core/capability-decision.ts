/**
 * CENTRAL DECISION ENGINE (UCE V1.1 Phase 4) — le cerveau central est le
 * SEUL décideur. Ce moteur transforme les DONNÉES mesurées (rapport du
 * bridge, monitoring, échecs, besoins non satisfaits) en DÉCISIONS
 * STRUCTURÉES (`CapabilityDecision`, contrat mission §Phase 4), évaluées
 * contre la politique d'autonomie (Phase 8) et persistées (cap_decisions).
 *
 * RÈgles d'architecture respectées :
 *  - les WORKERS sont des exécutants : ils ne produisent pas de décisions —
 *    la synthèse est déterministe (règles explicites sur données mesurées),
 *    jamais une invention d'un sous-système ;
 *  - chaque décision porte son niveau de risque et `requiresApproval` selon
 *    la politique d'autonomie — le moteur NE CONTOURNE jamais une gate ;
 *  - les décisions sont des ENREGISTREMENTS auditables : le cerveau (ou
 *    l'admin) peut les rejeter — un rejet est aussi persisté.
 */

import "server-only";

import { maintenantIso } from "./capability-contract";
import { nouvelId, sauvegarder, lister, recuperer, type RepositoryUceOptions } from "../storage/capability-repository";
import { evaluerAction, type ActionCapacite } from "../autonomy/autonomy-policy-engine";
import { refuserSiSecret } from "../security/secrets-protection";
import type { RapportPourCerveau } from "./capability-brain-bridge";

/** Décision structurée du cerveau central (contrat mission §Phase 4). */
export interface CapabilityDecision {
  decisionId: string;
  objective: string;
  action: ActionCapacite;
  targetCapability?: string;
  constraints: {
    maxCost?: number;
    maxDurationMs?: number;
    maxMemoryMb?: number;
    requiresApproval: boolean;
  };
  rationale: string;
  expectedOutcome: string;
  // ---- traçabilité UCE (au-delà du contrat mission) ----
  /** produite → planifiee → executee ; rejetee par le cerveau/admin. */
  statut: "produite" | "planifiee" | "executee" | "rejetee";
  priorite: "basse" | "normale" | "haute" | "critique";
  /** Verdict de la politique d'autonomie au moment de la production. */
  verdictPolitique: { autorise: boolean; approbationRequise: boolean; raison: string };
  produiteLe: string;
  produitePar: "cerveau-central";
  schemaVersion: number;
}

/** Enregistrement persisté : le repository exige `id` (= decisionId). */
export interface DecisionPersistee extends CapabilityDecision {
  id: string;
  majLe?: string;
}

function versPersistee(decision: CapabilityDecision): DecisionPersistee {
  return { ...decision, id: decision.decisionId };
}

/** Contexte d'entrée du cerveau (mission §Phase 4 — ce qu'il doit recevoir). */
export interface EntreeCerveau {
  rapport: RapportPourCerveau;
  /** Besoins non satisfaits (demandes d'utilisateurs sans outil, échecs). */
  besoinsNonSatisfaits?: string[];
  /** Objectifs courants du cerveau (libre, borné). */
  objectifs?: string[];
}

interface BrouillonDecision {
  objective: string;
  action: ActionCapacite;
  targetCapability?: string;
  priorite: CapabilityDecision["priorite"];
  rationale: string;
  expectedOutcome: string;
  sensibilite?: Partial<Pick<import("../autonomy/autonomy-policy-engine").ContexteAction, "coutPayant" | "toucheCerveau" | "toucheSecurite" | "secretOuCompteExterne" | "publicationOuSuppression">>;
}

/**
 * SYNTHESE DÉTERMINISTE des décisions du cerveau à partir de données
 * mesurées. Aucune invention : chaque décision cite sa mesure source.
 */
export function synthetiserDecisions(entree: EntreeCerveau): BrouillonDecision[] {
  const brouillons: BrouillonDecision[] = [];
  const { rapport, besoinsNonSatisfaits = [], objectifs = [] } = entree;

  // 1) Capacités DÉFAILLANTES — priorité au monitoring mesuré.
  for (const defaillante of rapport.defaillantes.slice(0, 5)) {
    const critique = defaillante.etat === "en_echec" && defaillante.echecsConsecutifs >= 5;
    brouillons.push({
      objective: `rétablir la fiabilité de ${defaillante.capabilityId} (taux de succès mesuré ${Math.round(defaillante.tauxSucces * 100)} %, ${defaillante.echecsConsecutifs} échec(s) consécutif(s))`,
      action: critique ? "replace" : "improve",
      targetCapability: defaillante.capabilityId,
      priorite: critique ? "critique" : "haute",
      rationale: `monitoring réel : état « ${defaillante.etat} », échecs consécutifs ${defaillante.echecsConsecutifs} — la mesure impose une action`,
      expectedOutcome: critique
        ? "capacité remplacée par une version/alternative testée en sandbox, l'ancienne conservée jusqu'à validation"
        : "cause des échecs corrigée, taux de succès mesuré revenu au-dessus du seuil",
      sensibilite: critique ? { toucheSecurite: false } : undefined,
    });
  }

  // 2) Performances dégradées (p95 mesuré trop lent) — amélioration.
  for (const perf of rapport.performances.filter((p) => p.dureeP95Ms > 15_000 && p.tauxSucces >= 0.9).slice(0, 3)) {
    brouillons.push({
      objective: `réduire la latence p95 de ${perf.capabilityId} (mesurée ${perf.dureeP95Ms} ms)`,
      action: "improve",
      targetCapability: perf.capabilityId,
      priorite: "normale",
      rationale: `performance mesurée p95 ${perf.dureeP95Ms} ms avec fiabilité conservée (${Math.round(perf.tauxSucces * 100)} %) — amélioration possible sans remplacement`,
      expectedOutcome: "p95 mesuré réduit et comparé avant/après sur le même scénario",
    });
  }

  // 3) Besoins non satisfaits — découverte de solutions candidates.
  for (const besoin of besoinsNonSatisfaits.slice(0, 3)) {
    const secret = refuserSiSecret(besoin);
    if (!secret.autorise) continue; // un besoin contaminé n'est jamais traité
    brouillons.push({
      objective: `couvrir le besoin non satisfait : ${besoin.slice(0, 120)}`,
      action: "discover",
      priorite: "haute",
      rationale: "besoin utilisateur/agent sans capacité existante identifiée (registre + échecs consultés)",
      expectedOutcome: "au moins trois candidates découvertes, comparées sur mesures réelles",
    });
  }

  // 4) Incidents ouverts — surveillance renforcée (action sûre).
  if (rapport.echecs.incidentsOuverts > 0) {
    brouillons.push({
      objective: `surveiller les ${rapport.echecs.incidentsOuverts} incident(s) ouvert(s) jusqu'à résolution`,
      action: "monitor",
      priorite: "normale",
      rationale: "incidents enregistrés par le monitoring — aucune modification sans diagnostic",
      expectedOutcome: "incidents résolus ou escaladés en décision d'amélioration/remplacement",
    });
  }

  // 5) Objectifs explicites du cerveau (le cerveau décide aussi d'agir).
  for (const objectif of objectifs.slice(0, 2)) {
    const secret = refuserSiSecret(objectif);
    if (!secret.autorise) continue;
    brouillons.push({
      objective: objectif.slice(0, 160),
      action: "evaluate",
      priorite: "basse",
      rationale: "objectif posé par le cerveau central — évaluation des capacités pertinentes avant toute action",
      expectedOutcome: "état mesuré de la capacité concernée et recommandation structurée",
    });
  }

  return brouillons;
}

/**
 * Produit et PERSISTE les décisions du cerveau (une décision = un
 * enregistrement auditable). Chaque verdict de politique est calculé RÉELLEMENT.
 */
export async function produireDecisions(entree: EntreeCerveau, options: RepositoryUceOptions = {}): Promise<CapabilityDecision[]> {
  const brouillons = synthetiserDecisions(entree);
  const decisions: CapabilityDecision[] = [];
  for (const brouillon of brouillons) {
    const verdict = await evaluerAction({ action: brouillon.action, cible: brouillon.targetCapability, ...brouillon.sensibilite }, options);
    const decision: CapabilityDecision = {
      decisionId: nouvelId("dec", `${brouillon.action}:${brouillon.targetCapability ?? brouillon.objective}`),
      objective: brouillon.objective.slice(0, 300),
      action: brouillon.action,
      targetCapability: brouillon.targetCapability,
      constraints: {
        maxDurationMs: brouillon.action === "monitor" ? 5_000 : 300_000,
        requiresApproval: verdict.approbationRequise,
      },
      rationale: brouillon.rationale.slice(0, 400),
      expectedOutcome: brouillon.expectedOutcome.slice(0, 300),
      statut: "produite",
      priorite: brouillon.priorite,
      verdictPolitique: { autorise: verdict.autorise, approbationRequise: verdict.approbationRequise, raison: verdict.raison },
      produiteLe: maintenantIso(),
      produitePar: "cerveau-central",
      schemaVersion: 1,
    };
    await sauvegarder("decisions", versPersistee(decision), options);
    decisions.push(decision);
  }
  return decisions;
}

/** Marque une décision planifiée (un plan d'amélioration y est rattaché). */
export async function marquerPlanifiee(decisionId: string, options: RepositoryUceOptions = {}): Promise<CapabilityDecision | null> {
  const decision = await recuperer<DecisionPersistee>("decisions", decisionId, options);
  if (!decision || decision.statut === "rejetee" || decision.statut === "executee") return decision ?? null;
  decision.statut = "planifiee";
  await sauvegarder("decisions", versPersistee(decision), options);
  return decision;
}

/** Marque une décision exécutée (preuve fournie par l'orchestrateur). */
export async function marquerExecutee(decisionId: string, options: RepositoryUceOptions = {}): Promise<CapabilityDecision | null> {
  const decision = await recuperer<DecisionPersistee>("decisions", decisionId, options);
  if (!decision || decision.statut === "rejetee") return decision ?? null;
  decision.statut = "executee";
  await sauvegarder("decisions", versPersistee(decision), options);
  return decision;
}

/** REJET d'une décision (par le cerveau ou l'admin) — audité, jamais effacé. */
export async function rejeterDecision(decisionId: string, raison: string, options: RepositoryUceOptions = {}): Promise<{ ok: boolean; raison: string }> {
  const decision = await recuperer<DecisionPersistee>("decisions", decisionId, options);
  if (!decision) return { ok: false, raison: `décision inconnue : ${decisionId}` };
  decision.statut = "rejetee";
  decision.rationale = `${decision.rationale} — REJET enregistré : ${raison.slice(0, 150)}`;
  await sauvegarder("decisions", versPersistee(decision), options);
  return { ok: true, raison: `décision ${decisionId} rejetée (audité)` };
}

/** Décisions récentes du cerveau (dashboard + orchestrateur). */
export async function decisionsRecentes(options: RepositoryUceOptions = {}, limite = 50): Promise<CapabilityDecision[]> {
  return lister<DecisionPersistee>("decisions", undefined, limite, options);
}

/** Les décisions prêtes pour la planification (produites, autorisées). */
export async function decisionsAPlanifier(options: RepositoryUceOptions = {}): Promise<CapabilityDecision[]> {
  const toutes = await decisionsRecentes(options, 100);
  return toutes.filter((d) => d.statut === "produite" && d.verdictPolitique.autorise);
}

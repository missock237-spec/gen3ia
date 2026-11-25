/**
 * FAILURE ANALYZER (UCE-028 support) — analyse des échecs réels des
 * exécutions : catégories récurrentes (timeout, refus, vérification,
 * mémoire), incidents ouverts (cap_incidents) et recommandations pour le
 * cerveau central (qui décide de la suite — les workers ne décident pas).
 */

import "server-only";

import { maintenantIso, type CapabilityExecution, type CapabilityIncident } from "../core/capability-contract";
import { sauvegarder, lister, nouvelId, type RepositoryUceOptions } from "../storage/capability-repository";

export interface CategorieEchec {
  categorie: "timeout" | "refusee" | "verification" | "erreur" | "annulee";
  nombre: number;
  capacitesConcernees: string[];
}

export interface RapportEchecs {
  executionsAnalysees: number;
  echecs: number;
  categories: CategorieEchec[];
  incidentsOuverts: number;
  recommandations: string[];
}

function categoriser(execution: CapabilityExecution): CategorieEchec["categorie"] {
  if (execution.status === "timeout") return "timeout";
  if (execution.status === "refusee") return "refusee";
  if (execution.status === "annulee") return "annulee";
  if (execution.status === "echec" && execution.verification?.verifie === false && execution.verification?.methode !== "aucune") {
    return "verification";
  }
  return "erreur";
}

/** Analyse les échecs des exécutions persistées (fenêtre 500 dernières). */
export async function analyserEchecs(options: RepositoryUceOptions = {}): Promise<RapportEchecs> {
  const executions = await lister<CapabilityExecution>("executions", undefined, 500, options);
  const parCategorie = new Map<CategorieEchec["categorie"], CategorieEchec>();
  let echecs = 0;
  for (const e of executions) {
    if (e.status === "succes" || e.status === "en_cours" || e.status === "planifiee" || e.status === "autorisee") continue;
    echecs++;
    const cat = categoriser(e);
    const entree = parCategorie.get(cat) ?? { categorie: cat, nombre: 0, capacitesConcernees: [] };
    entree.nombre++;
    if (!entree.capacitesConcernees.includes(e.capabilityId) && entree.capacitesConcernees.length < 10) {
      entree.capacitesConcernees.push(e.capabilityId);
    }
    parCategorie.set(cat, entree);
  }
  const categories = [...parCategorie.values()].sort((a, b) => b.nombre - a.nombre);
  const incidents = await lister<CapabilityIncident>("incidents", { statut: "ouvert" }, 200, options);

  const recommandations: string[] = [];
  for (const c of categories) {
    if (c.categorie === "timeout" && c.nombre >= 2) {
      recommandations.push(`${c.nombre} timeouts : réduire la charge des capacités ${c.capacitesConcernees.slice(0, 3).join(", ")}`);
    }
    if (c.categorie === "verification" && c.nombre >= 2) {
      recommandations.push(`${c.nombre} échecs de vérification : auditer les preuves exigées (result-verifier)`);
    }
    if (c.categorie === "refusee" && c.nombre >= 2) {
      recommandations.push(`${c.nombre} refus de permission : vérifier que les demandes respectent la politique (normal si test volontaire)`);
    }
  }
  if (incidents.length >= 3) {
    recommandations.push(`${incidents.length} incidents ouverts : prioriser leur résolution avant toute nouvelle intégration`);
  }
  return {
    executionsAnalysees: executions.length,
    echecs,
    categories,
    incidentsOuverts: incidents.length,
    recommandations,
  };
}

/** Ouvre un incident (anti-doublon : même capacité + même kind ouvert). */
export async function ouvrirIncident(params: {
  capabilityId: string;
  kind: CapabilityIncident["kind"];
  message: string;
}, options: RepositoryUceOptions = {}): Promise<{ ok: boolean; incident?: CapabilityIncident; raison: string }> {
  const existants = await lister<CapabilityIncident>("incidents", { statut: "ouvert" }, 200, options);
  const doublon = existants.find(
    (i) => i.capabilityId === params.capabilityId && i.kind === params.kind,
  );
  if (doublon) {
    return { ok: true, incident: doublon, raison: "incident déjà ouvert (pas de doublon)" };
  }
  const incident: CapabilityIncident = {
    id: nouvelId("capinc", `${params.capabilityId}:${params.kind}:${Date.now()}`),
    capabilityId: params.capabilityId.slice(0, 300),
    kind: params.kind,
    message: params.message.slice(0, 500),
    statut: "ouvert",
    ouvertLe: maintenantIso(),
    schemaVersion: 1,
  };
  await sauvegarder("incidents", incident, options);
  return { ok: true, incident, raison: "incident ouvert" };
}

/** Clôture un incident (résolu). */
export async function cloturerIncident(incidentId: string, options: RepositoryUceOptions = {}): Promise<{ ok: boolean; raison: string }> {
  const existants = await lister<CapabilityIncident>("incidents", undefined, 200, options);
  const incident = existants.find((i) => i.id === incidentId);
  if (!incident) return { ok: false, raison: "incident inconnu" };
  incident.statut = "resolu";
  incident.resoluLe = maintenantIso();
  await sauvegarder("incidents", incident, options);
  return { ok: true, raison: "incident résolu" };
}

/**
 * CAPABILITY HEALTH (UCE-030) — santé réelle des capacités, calculée depuis
 * les exécutions mesurées (cap_executions) : taux de succès, échecs
 * consécutifs, latence p50 — AUCUN indicateur inventé (mission §10 : pas de
 * faux indicateurs d'autonomie).
 */

import "server-only";

import { type CapabilityExecution } from "../core/capability-contract";
import { lister, type RepositoryUceOptions } from "../storage/capability-repository";

export interface SanteCapacite {
  capabilityId: string;
  executionsMesurees: number;
  tauxSucces: number;
  echecsConsecutifs: number;
  latenceP50Ms: number;
  /** saine | degradee | en_echec | inconnue (pas encore de mesure). */
  etat: "saine" | "degradee" | "en_echec" | "inconnue";
}

export interface RapportSante {
  capacites: SanteCapacite[];
  totalMesurees: number;
  enEchec: number;
  degradees: number;
}

function p50(valeurs: number[]): number {
  if (valeurs.length === 0) return 0;
  const triees = [...valeurs].sort((a, b) => a - b);
  return triees[Math.floor(triees.length / 2)];
}

/** Calcule la santé d'une capacité depuis ses exécutions réelles. */
export async function santeCapacite(
  capabilityId: string,
  options: RepositoryUceOptions = {},
): Promise<SanteCapacite> {
  const executions = (
    await lister<CapabilityExecution & { capabilityId?: string }>("executions", undefined, 500, options)
  ).filter((e) => (e as unknown as { capabilityId?: string }).capabilityId === capabilityId);
  if (executions.length === 0) {
    return {
      capabilityId,
      executionsMesurees: 0,
      tauxSucces: 0,
      echecsConsecutifs: 0,
      latenceP50Ms: 0,
      etat: "inconnue",
    };
  }
  const triees = [...executions].sort((a, b) => a.demarreLe.localeCompare(b.demarreLe));
  const succes = triees.filter((e) => e.status === "succes").length;
  const tauxSucces = succes / triees.length;
  let echecsConsecutifs = 0;
  for (let i = triees.length - 1; i >= 0; i--) {
    if (triees[i].status === "succes") break;
    echecsConsecutifs++;
  }
  const latenceP50 = p50(triees.filter((e) => e.status === "succes").map((e) => e.dureeMs));
  const etat: SanteCapacite["etat"] =
    echecsConsecutifs >= 3 || tauxSucces === 0
      ? "en_echec"
      : tauxSucces < 0.8
        ? "degradee"
        : "saine";
  return {
    capabilityId,
    executionsMesurees: triees.length,
    tauxSucces,
    echecsConsecutifs,
    latenceP50Ms: latenceP50,
    etat,
  };
}

/** Santé de toutes les capacités ayant au moins une exécution mesurée. */
export async function santeGlobale(options: RepositoryUceOptions = {}): Promise<RapportSante> {
  const executions = await lister<CapabilityExecution>("executions", undefined, 500, options);
  const ids = new Set<string>();
  for (const e of executions) {
    const id = (e as unknown as { capabilityId?: string }).capabilityId;
    if (typeof id === "string" && id) ids.add(id);
  }
  const capacites: SanteCapacite[] = [];
  for (const id of ids) capacites.push(await santeCapacite(id, options));
  capacites.sort((a, b) => a.etat.localeCompare(b.etat));
  return {
    capacites,
    totalMesurees: capacites.filter((c) => c.executionsMesurees > 0).length,
    enEchec: capacites.filter((c) => c.etat === "en_echec").length,
    degradees: capacites.filter((c) => c.etat === "degradee").length,
  };
}

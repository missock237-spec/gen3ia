/**
 * PERFORMANCE MONITOR (UCE-018 support) — performance mesurée des capacités
 * depuis les exécutions réelles (durée, taux de succès) et les benchmarks
 * persistés (p50/p95). Tout ce qui est renvoyé provient d'une mesure.
 */

import "server-only";

import os from "node:os";

import { type CapabilityExecution } from "../core/capability-contract";
import { lister, type RepositoryUceOptions } from "../storage/capability-repository";

export interface PerformanceCapacite {
  capabilityId: string;
  executions: number;
  tauxSucces: number;
  dureeMoyenneMs: number;
  dureeP95Ms: number;
}

function percentile(valeurs: number[], p: number): number {
  if (valeurs.length === 0) return 0;
  const triees = [...valeurs].sort((a, b) => a - b);
  const index = Math.min(triees.length - 1, Math.floor((p / 100) * triees.length));
  return triees[index];
}

/** Instantané SYNCHRONE des ressources du process + du système (mesures os). */
export interface InstantaneRessources {
  ramProcessUtiliseeMo: number;
  ramProcessPicMo: number;
  ramSystemeLibreMo: number;
  ramSystemeTotalMo: number;
  uptimeSecondes: number;
}

export function mesurerRessources(): InstantaneRessources {
  const memoire = process.memoryUsage();
  let libreMo = 0;
  let totalMo = 0;
  try {
    // os.freemem/os.totalmem : mesure système réelle (Node standard).
    libreMo = Math.round(os.freemem() / (1024 * 1024));
    totalMo = Math.round(os.totalmem() / (1024 * 1024));
  } catch {
    // os indisponible : 0 = « inconnu » honnête (jamais inventé).
    libreMo = 0;
    totalMo = 0;
  }
  return {
    ramProcessUtiliseeMo: Math.round(memoire.heapUsed / (1024 * 1024)),
    ramProcessPicMo: Math.round(memoire.heapTotal / (1024 * 1024)),
    ramSystemeLibreMo: libreMo,
    ramSystemeTotalMo: totalMo,
    uptimeSecondes: Math.round(process.uptime()),
  };
}

/** Performance mesurée d'une capacité (fenêtre = exécutions persistées). */
export async function performanceCapacite(
  capabilityId: string,
  options: RepositoryUceOptions = {},
): Promise<PerformanceCapacite> {
  const executions = (
    await lister<CapabilityExecution & { capabilityId?: string }>("executions", undefined, 500, options)
  ).filter((e) => (e as unknown as { capabilityId?: string }).capabilityId === capabilityId);
  if (executions.length === 0) {
    return { capabilityId, executions: 0, tauxSucces: 0, dureeMoyenneMs: 0, dureeP95Ms: 0 };
  }
  const durees = executions.map((e) => e.dureeMs);
  const succes = executions.filter((e) => e.status === "succes").length;
  return {
    capabilityId,
    executions: executions.length,
    tauxSucces: succes / executions.length,
    dureeMoyenneMs: Math.round(durees.reduce((s, d) => s + d, 0) / durees.length),
    dureeP95Ms: percentile(durees, 95),
  };
}

/** Performance de toutes les capacités mesurées, triée par durée p95. */
export async function performanceGlobale(options: RepositoryUceOptions = {}): Promise<PerformanceCapacite[]> {
  const executions = await lister<CapabilityExecution>("executions", undefined, 500, options);
  const ids = new Set<string>();
  for (const e of executions) {
    const id = (e as unknown as { capabilityId?: string }).capabilityId;
    if (typeof id === "string" && id) ids.add(id);
  }
  const resultats: PerformanceCapacite[] = [];
  for (const id of ids) resultats.push(await performanceCapacite(id, options));
  resultats.sort((a, b) => b.dureeP95Ms - a.dureeP95Ms);
  return resultats;
}

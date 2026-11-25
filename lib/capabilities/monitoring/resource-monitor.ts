/**
 * RESOURCE MONITOR (UCE-019 support) — ressources réellement consommées par
 * les capacités (CPU mesuré en durée, mémoire pic côté enfant de sandbox,
 * durée d'exécution). Persistance : collection cap_resources. Les limites
 * (mission §8 : CPU/mémoire/temps/stockage) sont rappelées ici et mesurées,
 * jamais estimées.
 */

import "server-only";

import {
  maintenantIso,
  type CapabilityResourceUsage,
} from "../core/capability-contract";
import { sauvegarder, lister, nouvelId, type RepositoryUceOptions } from "../storage/capability-repository";

/** Limites souples de ressource par exécution (alignées sandbox-manager). */
export const LIMITES_RESSOURCES = {
  /** Durée maximale d'une exécution sandbox (ms) — garde anti-boucle. */
  dureeMaxMs: 30_000,
  /** Mémoire maximale (Mo) — au-delà : incident « ressource ». */
  memoireMaxMo: 256,
} as const;

export interface ResultatRessource {
  ok: boolean;
  usage?: CapabilityResourceUsage;
  raison?: string;
  /** Vrai si une limite mesurée est dépassée (incident à ouvrir). */
  limiteDepassee: boolean;
}

/** Enregistre une mesure de ressource réelle d'une exécution. */
export async function enregistrerUsageRessource(params: {
  capabilityId: string;
  cpuMs?: number;
  memoirePicMo?: number;
  dureeMs: number;
}, options: RepositoryUceOptions = {}): Promise<ResultatRessource> {
  if (!params.capabilityId) return { ok: false, raison: "capabilityId obligatoire", limiteDepassee: false };
  const dureeMs = Math.max(0, Math.min(Number(params.dureeMs) || 0, 86_400_000));
  const memoirePicMo = params.memoirePicMo !== undefined ? Math.max(0, Number(params.memoirePicMo)) : undefined;
  const cpuMs = params.cpuMs !== undefined ? Math.max(0, Number(params.cpuMs)) : undefined;
  const limiteDepassee = dureeMs > LIMITES_RESSOURCES.dureeMaxMs
    || (memoirePicMo !== undefined && memoirePicMo > LIMITES_RESSOURCES.memoireMaxMo);
  const usage: CapabilityResourceUsage = {
    id: nouvelId("capres", `${params.capabilityId}:${Date.now()}`),
    capabilityId: params.capabilityId.slice(0, 300),
    cpuMs,
    memoirePicMo,
    dureeMs,
    mesureLe: maintenantIso(),
    schemaVersion: 1,
  };
  await sauvegarder("resources", usage, options);
  return {
    ok: true,
    usage,
    limiteDepassee,
    raison: limiteDepassee
      ? `limite dépassée : durée ${dureeMs} ms / mémoire ${memoirePicMo ?? "?"} Mo`
      : undefined,
  };
}

/** Consommation agrégée par capacité (moyennes mesurées, pics max). */
export interface UsageAgregate {
  capabilityId: string;
  mesures: number;
  dureeMoyenneMs: number;
  dureeMaxMs: number;
  memoirePicMaxMo?: number;
}

export async function usageParCapacite(options: RepositoryUceOptions = {}): Promise<Array<UsageAgregate>> {
  const usages = await lister<CapabilityResourceUsage>("resources", undefined, 500, options);
  const parCapacite = new Map<string, CapabilityResourceUsage[]>();
  for (const u of usages) {
    const liste = parCapacite.get(u.capabilityId) ?? [];
    liste.push(u);
    parCapacite.set(u.capabilityId, liste);
  }
  const resultats: Array<UsageAgregate> = [];
  for (const [capabilityId, liste] of parCapacite) {
    const durees = liste.map((u) => u.dureeMs);
    const memoires = liste.map((u) => u.memoirePicMo).filter((m): m is number => typeof m === "number");
    resultats.push({
      capabilityId,
      mesures: liste.length,
      dureeMoyenneMs: Math.round(durees.reduce((s, d) => s + d, 0) / durees.length),
      dureeMaxMs: Math.max(...durees),
      memoirePicMaxMo: memoires.length > 0 ? Math.max(...memoires) : undefined,
    });
  }
  return resultats.sort((a, b) => b.dureeMaxMs - a.dureeMaxMs);
}

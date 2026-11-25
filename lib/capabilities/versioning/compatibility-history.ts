/**
 * COMPATIBILITY HISTORY (UCE-015 suite) — compatibilité entre versions.
 *
 * Chaque contrôle de compatibilité réalisé par le compatibility-engine
 * (évaluation/) peut être enregistré ici, associé à une version précise.
 * L'historique permet de savoir si une version passée restait compatible
 * avec l'environnement du moment — utile pour juger un rollback.
 */

import "server-only";

import { maintenantIso } from "../core/capability-contract";
import { sauvegarder, lister, nouvelId, type RepositoryUceOptions } from "../storage/capability-repository";

export interface EnregistrementCompatibilite {
  id: string;
  capabilityId: string;
  version: string;
  verdict: "compatible" | "risque" | "incompatible";
  /** Contrôles vérifiés à ce moment (résumé borné). */
  controles: Array<{ nom: string; ok: boolean; detail?: string }>;
  environnement: string;
  verifieLe: string;
  schemaVersion: number;
}

/** Enregistre le résultat d'un contrôle de compatibilité pour une version. */
export async function enregistrerCompatibilite(params: {
  capabilityId: string;
  version: string;
  verdict: EnregistrementCompatibilite["verdict"];
  controles: Array<{ nom: string; ok: boolean; detail?: string }>;
  environnement?: string;
}, options: RepositoryUceOptions = {}): Promise<EnregistrementCompatibilite> {
  const record: EnregistrementCompatibilite = {
    id: nouvelId("capcomp", `${params.capabilityId}:${params.version}:${Date.now()}`),
    capabilityId: params.capabilityId.slice(0, 300),
    version: params.version.slice(0, 60),
    verdict: params.verdict,
    controles: params.controles.slice(0, 50).map((c) => ({
      nom: String(c.nom).slice(0, 120),
      ok: Boolean(c.ok),
      detail: c.detail ? String(c.detail).slice(0, 300) : undefined,
    })),
    environnement: (params.environnement ?? process.platform).slice(0, 120),
    verifieLe: maintenantIso(),
    schemaVersion: 1,
  };
  await sauvegarder("dependencies", record as unknown as { id: string }, options);
  return record;
}

/** Historique de compatibilité d'une capacité (plus récent d'abord). */
export async function historiqueCompatibilite(
  capabilityId: string,
  options: RepositoryUceOptions = {},
): Promise<EnregistrementCompatibilite[]> {
  const tous = await lister<EnregistrementCompatibilite & { capabilityId?: string }>(
    "dependencies",
    undefined,
    500,
    options,
  );
  return tous
    .filter((r) => (r as unknown as { capabilityId?: string }).capabilityId === capabilityId)
    .sort((a, b) => b.verifieLe.localeCompare(a.verifieLe));
}

/** La version demandée était-elle compatible lors de son dernier contrôle ? */
export async function compatibiliteDerniere(
  capabilityId: string,
  version: string,
  options: RepositoryUceOptions = {},
): Promise<EnregistrementCompatibilite | null> {
  const historique = await historiqueCompatibilite(capabilityId, options);
  return historique.find((h) => h.version === version) ?? null;
}

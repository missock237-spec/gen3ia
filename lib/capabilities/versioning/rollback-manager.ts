/**
 * ROLLBACK MANAGER (UCE-015 suite) — retour à une version précédente
 * (mission §2.I : « Revenir à une version précédente en cas de régression »).
 *
 * Garanties :
 *  - le rollback passe par la machine à états (statut « rollback » tracé
 *    sur la capacité) — jamais un remplacement silencieux ;
 *  - chaque rollback produit un enregistrement CapabilityRollback persisté
 *    (depuis/vers/raison/résultat) ;
 *  - l'ancienne version active est conservée (statut « rollback » côté
 *    version défaillante), jamais supprimée.
 */

import "server-only";

import {
  maintenantIso,
  type CapabilityRollback,
  type CapabilityVersion,
} from "../core/capability-contract";
import { sauvegarder, recuperer, lister, nouvelId, type RepositoryUceOptions } from "../storage/capability-repository";
import { obtenirGestionnaireCapacites } from "../core/capability-manager";

export interface ResultatRollback {
  ok: boolean;
  raison: string;
  rollback?: CapabilityRollback;
}

/**
 * Effectue le rollback d'une capacité vers une version précédente.
 * La version cible doit exister et ne pas être « retraitee » sans tests ;
 * l'opération est idempotente (rollback vers la version déjà active = ok).
 */
export async function effectuerRollback(params: {
  capabilityId: string;
  versVersionId: string;
  raison: string;
  effectuePar?: string;
}, options: RepositoryUceOptions = {}): Promise<ResultatRollback> {
  const cible = await recuperer<CapabilityVersion>("versions", params.versVersionId, options);
  if (!cible || cible.capabilityId !== params.capabilityId) {
    return { ok: false, raison: "version cible inconnue ou d'une autre capacité" };
  }
  if (cible.statut === "active") {
    return { ok: true, raison: "version cible déjà active (idempotent)" };
  }

  const gestionnaire = obtenirGestionnaireCapacites(options);
  const capacite = await gestionnaire.obtenir(params.capabilityId);
  if (!capacite) return { ok: false, raison: `capacité inconnue : ${params.capabilityId}` };

  // Statut « rollback » tracé via la machine à états (integree/validee → rollback).
  const transition = await gestionnaire.transitionner(params.capabilityId, "rollback", {});
  if (!transition.ok) {
    return { ok: false, raison: `rollback refusé par la machine à états : ${transition.raison}` };
  }

  // Retirer la version active défaillante (statut « rollback » côté version).
  const existantes = await lister<CapabilityVersion>("versions", { capabilityId: params.capabilityId }, 500, options);
  for (const ancienne of existantes) {
    if (ancienne.statut === "active") {
      ancienne.statut = "rollback";
      ancienne.changements = `${ancienne.changements}\n[rollback vers ${cible.version} le ${maintenantIso()} : ${params.raison.slice(0, 200)}]`.slice(0, 2_000);
      await sauvegarder("versions", ancienne, options);
    }
  }
  cible.statut = "active";
  await sauvegarder("versions", cible, options);

  const enregistrement: CapabilityRollback = {
    id: nouvelId("caprb", `${params.capabilityId}:${cible.version}`),
    capabilityId: params.capabilityId,
    depuisVersion: (existantes.find((v) => v.statut === "rollback")?.version ?? "inconnue").slice(0, 60),
    versVersion: cible.version,
    raison: params.raison.slice(0, 500),
    resultat: "succes",
    effectueLe: maintenantIso(),
    schemaVersion: 1,
  };
  await sauvegarder("rollbacks", enregistrement, options);
  return { ok: true, raison: `rollback effectué vers ${cible.version}`, rollback: enregistrement };
}

/** Historique des rollbacks d'une capacité (audit). */
export async function historiqueRollbacks(
  capabilityId: string | undefined,
  options: RepositoryUceOptions = {},
): Promise<CapabilityRollback[]> {
  const filtre = capabilityId ? { capabilityId } : undefined;
  return lister<CapabilityRollback>("rollbacks", filtre, 200, options);
}

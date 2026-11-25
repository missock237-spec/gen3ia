/**
 * CAPABILITY VERSION MANAGER (UCE-015) — gestionnaire de versions des
 * capacités (mission §2.I).
 *
 * Garanties :
 *  - aucune nouvelle version ne remplace une version stable sans validation :
 *    la promotion « staged → active » exige un jeu de tests TOUS verts,
 *    mesuré réellement (les résultats de tests sont fournis par l'appelant
 *    mais leur succès est vérifié ici — impossible de promouvoir avec un
 *    test échoué) ;
 *  - historique complet (historiqueVersions) ;
 *  - compatibilité entre versions (compatibility-history.ts).
 */

import "server-only";

import {
  maintenantIso,
  type CapabilityVersion,
} from "../core/capability-contract";
import { sauvegarder, lister, recuperer, type RepositoryUceOptions } from "../storage/capability-repository";
import { nouvelId } from "../storage/capability-repository";
import { refuserSiSecret } from "../security/secrets-protection";

export interface ResultatVersion {
  ok: boolean;
  version?: CapabilityVersion;
  raison: string;
}

export interface DemandeVersion {
  capabilityId: string;
  version: string;
  changements: string;
  parentVersion?: string;
  /** Tests de non-régression mesurés (nom + ok + durée) — obligatoires. */
  tests: Array<{ nom: string; ok: boolean; dureeMs: number }>;
}

const MAX_TEST_NOM = 200;

/** Publie une NOUVELLE version au statut « staged » (jamais active d'emblée). */
export async function publierVersion(
  demande: DemandeVersion,
  options: RepositoryUceOptions = {},
): Promise<ResultatVersion> {
  if (!demande.capabilityId || !demande.version) {
    return { ok: false, raison: "capabilityId et version obligatoires" };
  }
  if (!Array.isArray(demande.tests) || demande.tests.length === 0) {
    return {
      ok: false,
      raison: "aucun test fourni : une version sans tests mesurés ne peut pas être publiée",
    };
  }
  const secret = refuserSiSecret(demande.changements ?? "");
  if (!secret.autorise) {
    return { ok: false, raison: `changements refusés : ${secret.cause}` };
  }
  const tests = demande.tests.slice(0, 200).map((t) => ({
    nom: String(t.nom ?? "").slice(0, MAX_TEST_NOM),
    ok: Boolean(t.ok),
    dureeMs: Math.max(0, Math.min(Number(t.dureeMs) || 0, 3_600_000)),
  }));
  const version: CapabilityVersion = {
    id: nouvelId("capver", `${demande.capabilityId}:${demande.version}`),
    capabilityId: demande.capabilityId,
    version: demande.version.slice(0, 60),
    statut: "staged",
    changements: (demande.changements ?? "").slice(0, 2_000),
    parentVersion: demande.parentVersion?.slice(0, 60),
    tests,
    creeLe: maintenantIso(),
    schemaVersion: 1,
  };
  await sauvegarder("versions", version, options);
  return { ok: true, version, raison: "version publiée au statut staged" };
}

/**
 * PROMOTION GATED : « staged → active ». Exige que TOUS les tests mesurés
 * passent ; l'ancienne version active est retirée (statut « retraitee ») et
 * reste disponible pour le rollback (rollback-manager).
 */
export async function promouvoirVersion(
  versionId: string,
  options: RepositoryUceOptions = {},
): Promise<ResultatVersion> {
  const version = await recuperer<CapabilityVersion>("versions", versionId, options);
  if (!version) return { ok: false, raison: `version inconnue : ${versionId}` };
  if (version.statut === "active") {
    return { ok: true, version, raison: "déjà active (idempotent)" };
  }
  if (version.statut === "retraitee" || version.statut === "rollback") {
    return { ok: false, raison: `version ${version.statut} : promotion interdite (créer une nouvelle version)` };
  }
  const testsEchoues = version.tests.filter((t) => !t.ok);
  if (testsEchoues.length > 0) {
    return {
      ok: false,
      raison: `promotion refusée : ${testsEchoues.length} test(s) en échec (${testsEchoues.map((t) => t.nom).slice(0, 5).join(", ")})`,
    };
  }
  // Retirer l'ancienne version active (elle reste en historique).
  const existantes = await lister<CapabilityVersion>(
    "versions",
    { capabilityId: version.capabilityId },
    500,
    options,
  );
  for (const ancienne of existantes) {
    if (ancienne.id !== version.id && ancienne.statut === "active") {
      ancienne.statut = "retraitee";
      ancienne.changements = `${ancienne.changements}\n[retraitée le ${maintenantIso()} au profit de ${version.version}]`.slice(0, 2_000);
      await sauvegarder("versions", ancienne, options);
    }
  }
  version.statut = "active";
  await sauvegarder("versions", version, options);
  return { ok: true, version, raison: `version ${version.version} active (tests : ${version.tests.length}/${version.tests.length} verts)` };
}

/** Version active d'une capacité (null si aucune). */
export async function versionActive(
  capabilityId: string,
  options: RepositoryUceOptions = {},
): Promise<CapabilityVersion | null> {
  const existantes = await lister<CapabilityVersion>(
    "versions",
    { capabilityId },
    500,
    options,
  );
  return existantes.find((v) => v.statut === "active") ?? null;
}

/** Historique complet des versions d'une capacité (plus récent d'abord). */
export async function historiqueVersions(
  capabilityId: string,
  options: RepositoryUceOptions = {},
): Promise<CapabilityVersion[]> {
  const existantes = await lister<CapabilityVersion>(
    "versions",
    { capabilityId },
    500,
    options,
  );
  return existantes.sort((a, b) => b.creeLe.localeCompare(a.creeLe));
}

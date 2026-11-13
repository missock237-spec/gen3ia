import "server-only";

import { resilientGet, resilientQuery, writeCheckpointSet } from "@/lib/db/firestore-resilient";

import { journaliser } from "@/lib/genapi/provisionnement";
import { cleDateJour } from "@/lib/genapi/compteur";
import { caDisponible, normaliserEmpreinte } from "@/lib/genapi/openssl";
import type { ClientGenAPI, StatutGenAPI } from "@/lib/genapi/types";

/**
 * genAPI — REGISTRE DES CLIENTS + ALLOWLIST D'EMPREINTES.
 *
 * L'allowlist est le lien cryptographique Firestore entre une connexion
 * mTLS (certificat signé par la CA racine gen3) et un compte client SaaS :
 * le serveur gRPC refuse toute exécution dont l'empreinte de certificat
 * n'est pas allowlistée ET au statut « actif ».
 */

/** Durée du cache mémoire des verdicts d'empreinte (60 s). */
const TTL_CACHE_EMPREINTES_MS = 60_000;

/** Cache mémoire empreinte → verdict { ok, expireA } (60 s, borné). */
const cacheEmpreintes = new Map<string, { ok: boolean; expireA: number }>();

/** Vide le cache d'allowlist (appelé après révocation, exposé aux tests). */
export function reinitialiserCacheEmpreintes(): void {
  cacheEmpreintes.clear();
}

/** Liste les clients genAPI (les plus récents d'abord, plafond 200). */
export async function listerClients(): Promise<ClientGenAPI[]> {
  const resultats = await resilientQuery<Record<string, unknown>>(
    "genapiClients",
    [],
    { orderField: "creeA", descending: true, limit: 200 },
  );
  return resultats.map((doc) => ({
    uid: String(doc.uid ?? ""),
    email: String(doc.email ?? ""),
    empreinte: String(doc.empreinte ?? ""),
    statut: doc.statut === "revoque" ? "revoque" : "actif",
    creeA: String(doc.creeA ?? ""),
    ...(doc.revoqueA ? { revoqueA: String(doc.revoqueA) } : {}),
  }));
}

/**
 * Révoque un client : statut « revoque » + revoqueA (ISO), le cache
 * d'allowlist est vidé (la révocation est effective immédiatement pour les
 * nouvelles connexions). Retourne true si l'écriture a réussi.
 */
export async function revoquerClient(uid: string): Promise<boolean> {
  try {
    if (typeof uid !== "string" || uid.length === 0 || uid.length > 80 || /[/\\\r\n]/.test(uid)) {
      throw new Error("uid client invalide.");
    }
    const revoqueA = new Date().toISOString();
    await writeCheckpointSet(
      "genapiClients",
      uid,
      { statut: "revoque", revoqueA },
      uid,
    );
    reinitialiserCacheEmpreintes();
    await journaliser("client_revoque", `Client ${uid} révoqué à ${revoqueA} (allowlist vidée, empreinte refusée).`);
    return true;
  } catch (erreur: unknown) {
    await journaliser(
      "client_revoque_ko",
      `Révocation de ${uid} impossible : ${erreur instanceof Error ? erreur.message : String(erreur)}`,
    );
    return false;
  }
}

/**
 * L'empreinte (hex SHA-256 du certificat) est-elle allowlistée ET active ?
 * Cache mémoire 60 s pour absorber les rafales d'appels gRPC sans
 * requête Firestore à chaque appel.
 */
export async function empreinteAutorisee(empreinte: string): Promise<boolean> {
  let cle: string;
  try {
    cle = normaliserEmpreinte(empreinte);
  } catch {
    return false; // empreinte malformée : refus immédiat (pas d'exception côté gRPC)
  }
  const cache = cacheEmpreintes.get(cle);
  const maintenant = Date.now();
  if (cache && cache.expireA > maintenant) return cache.ok;

  const resultats = await resilientQuery<Record<string, unknown>>(
    "genapiClients",
    [{ field: "empreinte", value: cle }],
    { limit: 1 },
  );
  const doc = resultats[0];
  // DÉFENSE : on revérifie l'égalité exacte du champ stocké (le champ
  // requêté et le champ lu ne peuvent jamais diverger, mais l'allowlist
  // reste un garde-fou de sécurité — explicite et mesurable).
  const ok = Boolean(doc && doc.statut === "actif" && String(doc.empreinte ?? "") === cle);
  cacheEmpreintes.set(cle, { ok, expireA: maintenant + TTL_CACHE_EMPREINTES_MS });
  return ok;
}

/**
 * État de santé genAPI pour la console admin : disponibilité de la CA
 * racine + compteurs du jour (`genapiStats/{dateIso}`) + décompte clients.
 */
export async function statutGenAPI(): Promise<StatutGenAPI> {
  const date = cleDateJour();
  const [caOk, stats, clients] = await Promise.all([
    caDisponible(),
    resilientGet<Record<string, unknown>>("genapiStats", date),
    resilientQuery<Record<string, unknown>>("genapiClients", [], { limit: 200 }),
  ]);
  return {
    caDisponible: caOk,
    clientsActifs: clients.filter((c) => c.statut === "actif").length,
    clientsTotal: clients.length,
    executions: Number(stats?.executions ?? 0),
    echecs: Number(stats?.echecs ?? 0),
    creditsDebitesMinor: Number(stats?.creditsDebitesMinor ?? 0),
    date,
  };
}

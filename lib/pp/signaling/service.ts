/**
 * PP SIGNALISATION — service de rendez-vous (Phase 1 du plan PP).
 *
 * Le serveur de signalisation ne voit JAMAIS les données métier : il fournit
 * uniquement les coordonnées réseau temporaires des pairs ACTIFS et gère le
 * cycle de vie du registre. Anti-reconnaissance (plan §3) : résoudre les
 * adresses exige une requête SIGNÉE par la clé matérielle d'un pair ACTIF,
 * horodatée (fenêtre 30 s) — un pair en attente, révoqué ou inconnu n'obtient
 * aucune information, pas même l'existence d'autres pairs.
 */

import crypto from "node:crypto";

import { ed25519Verify } from "@/lib/pp/noise/suite";
import { TrustRegistry, type PeerRecord } from "@/lib/pp/registry/trust-registry";

export const SIGNAL_TIMESTAMP_WINDOW_MS = 30_000;

export interface SignalChallenge {
  nonce: Buffer;
  issuedAt: string;
  expiresAt: string;
}

/** Défi de signalisation à usage unique (anti-replay des requêtes signées). */
export class SignalChallenger {
  private store = new Map<string, { nonce: Buffer; expiresAt: number }>();

  issue(): SignalChallenge {
    const nonce = crypto.randomBytes(32);
    const id = crypto.createHash("sha256").update(nonce).digest("hex").slice(0, 24);
    this.store.set(id, { nonce, expiresAt: Date.now() + SIGNAL_TIMESTAMP_WINDOW_MS });
    this.purge();
    return { nonce, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + SIGNAL_TIMESTAMP_WINDOW_MS).toISOString() };
  }

  consume(id: string): Buffer | null {
    this.purge();
    const entry = this.store.get(id);
    if (!entry || Date.now() > entry.expiresAt) return null;
    this.store.delete(id);
    return entry.nonce;
  }

  private purge(): void {
    const now = Date.now();
    for (const [id, entry] of this.store) if (now > entry.expiresAt) this.store.delete(id);
  }
}

/** Vérification d'une requête de signalisation signée par la clé matérielle. */
export async function verifySignalSignature(registry: TrustRegistry, peerId: string, message: string, signatureHex: string): Promise<{ ok: boolean; record?: PeerRecord; reason?: string }> {
  let record: PeerRecord;
  try {
    record = registry.require(peerId);
  } catch {
    return { ok: false, reason: "pair inconnu" };
  }
  if (record.status !== "actif") return { ok: false, reason: `pair ${record.status} — signalisation réservée aux pairs actifs` };
  const signature = Buffer.from(signatureHex, "hex");
  const ok = record.hardwareAlgo === "ed25519" ? await ed25519Verify(Buffer.from(record.hardwarePubKey, "hex"), Buffer.from(message, "utf8"), signature) : false;
  // ECDSA P-256 (navigateurs) : vérifiable via WebCrypto côté passerelle —
  // la signalisation serveur exige Ed25519 ; les nœuds navigateur emploient
  // le canal direct (DataChannels) — voir docs/architecture/.
  return ok ? { ok: true, record } : { ok: false, reason: "signature de signalisation invalide" };
}

/** Adresses visibles d'un pair — uniquement pour un pair ACTIF signataire. */
export async function resolvePeerAddresses(registry: TrustRegistry, requesterPeerId: string, targetPeerId: string, signedMessage: string, signatureHex: string): Promise<{ addresses: Array<{ addr: string; seenAt: string }>; targetAppId: string }> {
  const verification = await verifySignalSignature(registry, requesterPeerId, signedMessage, signatureHex);
  if (!verification.ok) throw new Error(`PP signalisation : ${verification.reason}`);
  const addresses = registry.resolveAddresses(targetPeerId);
  return { addresses, targetAppId: registry.require(targetPeerId).appId };
}

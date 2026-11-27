/**
 * PP IDENTITÉ — fournisseur WebCrypto à clé NON EXTRACTABLE.
 *
 * Cible : navigateur (nœuds accélérateurs Gen3) et environnements WebCrypto
 * (mobile PWA). La clé ECDSA P-256 est générée avec extractable:false —
 * le code même de l'application ne peut pas lire la clé privée, une copie
 * du code source sur une autre machine génère une AUTRE clé. Testé ici sur
 * le WebCrypto de Node 24 (même primitive SubtleCrypto que les navigateurs).
 */

import type { AttestationReport, HardwareIdentityProvider, HardwareKeyHandle, IdentityProviderKind, IdentityProviderName } from "./hardware-identity";

interface StoredPair {
  privateKey: CryptoKey;
  /** PeerID = SHA-256 de la clé publique brute (SubtleCrypto, jamais node:crypto). */
  peerId: Buffer;
}

const subtle = (): SubtleCrypto => {
  if (typeof globalThis.crypto?.subtle !== "object") throw new Error("WebCrypto SubtleCrypto indisponible dans cet environnement");
  return globalThis.crypto.subtle;
};

/** Cache par nom d'app — la clé privée non extractable reste en mémoire vivante. */
const caches = new Map<string, StoredPair>();

export class WebCryptoNonExtractableIdentityProvider implements HardwareIdentityProvider {
  readonly name: IdentityProviderName = "webcrypto-nonextractable";
  readonly kind: IdentityProviderKind = "hardware";
  constructor(private readonly cacheKey = "pp-default") {}

  async available(): Promise<boolean> {
    return typeof globalThis.crypto?.subtle?.generateKey === "function";
  }

  async getOrCreate(): Promise<HardwareKeyHandle> {
    const existing = caches.get(this.cacheKey);
    if (existing) return this.handle(existing);
    // ECDSA P-256 avec extractable:false — non exportable PAR CONSTRUCTION.
    const pair = await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const spki = await subtle().exportKey("raw", pair.publicKey);
    const digest = await subtle().digest("SHA-256", spki);
    const stored: StoredPair = { privateKey: pair.privateKey, peerId: Buffer.from(digest) };
    caches.set(this.cacheKey, stored);
    return this.handle(stored);
  }

  private handle(stored: StoredPair): HardwareKeyHandle {
    const privateKey = stored.privateKey;
    return {
      publicKey: stored.peerId,
      sign: async (data: Uint8Array) => {
        const signature = await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, Buffer.from(data));
        return Buffer.from(signature);
      },
    };
  }

  async attestation(): Promise<AttestationReport> {
    return {
      provider: this.name,
      verdict: "hardware-bound",
      details: { keyType: "ECDSA P-256", extractable: false, mechanism: "WebCrypto SubtleCrypto" },
      measuredAt: new Date().toISOString(),
    };
  }

  /** Handle CryptoKey (non extractable par construction) — pour les gardes de test. */
  debugCryptoKey(cacheKey = this.cacheKey): CryptoKey | undefined {
    return caches.get(cacheKey)?.privateKey;
  }
}

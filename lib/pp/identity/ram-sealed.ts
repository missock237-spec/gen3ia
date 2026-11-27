/**
 * PP IDENTITÉ — fournisseur RAM scellé (repli serveur, plan PP §4).
 *
 * Pour Docker/VPS sans TPM : la clé Ed25519 naît au premier démarrage, vit
 * en RAM (jamais sérialisée en clair) et, au repos, est scellée par
 * AES-256-GCM sous un secret injecté hors du disque (variable d'environnement
 * éphémère / injecteur de secrets) lié à l'empreinte machine. Le vol du
 * disque sans le secret d'injection est inutilisable ; le vol du code source
 * seul ne donne AUCUNE clé. Statut : TESTÉ (sandbox Node 24).
 */

import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { machineFingerprint, type AttestationReport, type HardwareIdentityProvider, type HardwareKeyHandle, type IdentityProviderKind, type IdentityProviderName } from "./hardware-identity";

interface SealedBlob {
  fingerprint: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

let inMemoryKeyPair: { publicKey: Buffer; privateKey: crypto.KeyObject } | null = null;

/** Dérivation du secret de scellement : PP_SEAL_SECRET ⊕ empreinte machine. */
function sealSecret(sealSecretEnv: string): Buffer {
  return crypto.createHash("sha256").update(`${sealSecretEnv}::${machineFingerprint()}`).digest();
}

export class RamSealedIdentityProvider implements HardwareIdentityProvider {
  readonly name: IdentityProviderName = "ram-sealed";
  readonly kind: IdentityProviderKind = "software-fallback";

  constructor(private readonly opts: { sealSecret: string; storagePath?: string }) {
    if (!opts.sealSecret || opts.sealSecret.length < 16) {
      throw new Error("RamSealedIdentityProvider : PP_SEAL_SECRET absent ou trop court (refus de clé non scellée)");
    }
  }

  async available(): Promise<boolean> {
    return Boolean(this.opts.sealSecret);
  }

  async getOrCreate(): Promise<HardwareKeyHandle> {
    if (inMemoryKeyPair) return this.handle(inMemoryKeyPair);
    const key = sealSecret(this.opts.sealSecret);

    // 1) Tentative de déscellement du blob au repos.
    if (this.opts.storagePath) {
      try {
        const blob = JSON.parse(await readFile(this.opts.storagePath, "utf8")) as SealedBlob;
        if (blob.fingerprint !== machineFingerprint()) {
          throw new Error("empreinte machine différente — clé jamais déscellée sur une autre machine");
        }
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"), { authTagLength: 16 });
        decipher.setAAD(Buffer.from(blob.fingerprint));
        decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
        const der = Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, "hex")), decipher.final()]);
        inMemoryKeyPair = { publicKey: x25519OrEd25519PublicFromPkcs8(der), privateKey: crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" }) };
        return this.handle(inMemoryKeyPair);
      } catch (error) {
        if (error instanceof Error && error.message.includes("empreinte")) throw error;
        // Blob absent ou corrompu → nouvelle clé (ré-enrôlement requis côté registre).
      }
    }

    // 2) Génération d'une clé Ed25519 fraîche, scellée immédiatement au repos.
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    inMemoryKeyPair = { publicKey: Buffer.from(publicKey.export({ type: "spki", format: "der" }).subarray(12)), privateKey };
    if (this.opts.storagePath) {
      const der = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
      const fingerprint = machineFingerprint();
      cipher.setAAD(Buffer.from(fingerprint));
      const sealed = Buffer.concat([cipher.update(der), cipher.final()]);
      const blob: SealedBlob = { fingerprint, iv: iv.toString("hex"), ciphertext: sealed.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
      await writeFile(this.opts.storagePath, JSON.stringify(blob), { mode: 0o600 });
    }
    return this.handle(inMemoryKeyPair);
  }

  private handle(pair: { publicKey: Buffer; privateKey: crypto.KeyObject }): HardwareKeyHandle {
    const privateKey = pair.privateKey;
    return {
      publicKey: pair.publicKey,
      sign: async (data: Uint8Array) => crypto.sign(null, Buffer.from(data), privateKey),
    };
  }

  async attestation(): Promise<AttestationReport> {
    return {
      provider: this.name,
      verdict: "environment-sealed",
      details: {
        mechanism: "Ed25519 scellée AES-256-GCM (secret d'injection + empreinte machine)",
        fingerprint: machineFingerprint().slice(0, 16),
        persistent: Boolean(this.opts.storagePath),
      },
      measuredAt: new Date().toISOString(),
    };
  }
}

/** Clé publique brute depuis un DER PKCS#8 Ed25519. */
function x25519OrEd25519PublicFromPkcs8(der: Buffer): Buffer {
  const pub = crypto.createPublicKey(crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
  const spki = pub.export({ type: "spki", format: "der" }) as Buffer;
  return Buffer.from(spki.subarray(spki.length - 32));
}

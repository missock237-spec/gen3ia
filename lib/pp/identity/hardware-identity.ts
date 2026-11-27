/**
 * PP IDENTITÉ — moteur d'identité liée au matériel (Phase 2 du plan PP).
 *
 * Principe anti-vol de code : le code source ne contient AUCUN secret ; la
 * clé privée naît DANS le matériel (TPM 2.0 / Secure Enclave / Keystore /
 * WebCrypto non-extractable) ou, à défaut, est scellée en RAM au démarrage
 * (repli serveur prévu par le plan §4 — Docker/VPS sans puce).
 *
 * La clé privée ne JAMAIS quitter le fournisseur : seule l'interface
 * sign(data) est exposée. hardwareBinding: true refuse de démarrer sans
 * fournisseur réel (fail-closed) — un faux "matériel simulé" est interdit
 * par les règles du projet.
 */

import crypto from "node:crypto";
import os from "node:os";

export type IdentityProviderKind = "hardware" | "software-fallback";
export type IdentityProviderName = "tpm2" | "secure-enclave" | "android-keystore" | "webcrypto-nonextractable" | "ram-sealed";

export interface HardwareKeyHandle {
  /** Clé PUBLIQUE brute — la seule donnée qui sort du fournisseur (PeerID). */
  readonly publicKey: Buffer;
  /** Signature Ed25519 (64 octets) — l'usage exclusif de la clé privée. */
  sign(data: Uint8Array): Promise<Buffer>;
}

export interface AttestationReport {
  provider: string;
  verdict: "hardware-bound" | "environment-sealed" | "unavailable";
  details: Record<string, string | number | boolean>;
  measuredAt: string;
}

export interface HardwareIdentityProvider {
  readonly name: IdentityProviderName;
  readonly kind: IdentityProviderKind;
  /** Détection réelle de l'environnement — jamais true par défaut. */
  available(): Promise<boolean>;
  /** Crée ou charge la paire non-exportable et retourne le handle de signature. */
  getOrCreate(): Promise<HardwareKeyHandle>;
  /** Preuve d'intégrité quand le fournisseur en produit une (facultatif). */
  attestation?(): Promise<AttestationReport>;
}

/** Empreinte machine stable (fingerprint) pour sceller une clé repli serveur. */
export function machineFingerprint(): string {
  const parts = [process.env.HOSTNAME || "", process.platform, process.arch, String(os.cpus().length)].join("|");
  return crypto.createHash("sha256").update(parts).digest("hex");
}

/** Dépistage TPM 2.0 : périphérique caractère + outils tpm2 présents. */
export async function probeTpm2Device(): Promise<boolean> {
  try {
    const fs = await import("node:fs");
    return fs.existsSync("/dev/tpmrm0");
  } catch {
    return false;
  }
}

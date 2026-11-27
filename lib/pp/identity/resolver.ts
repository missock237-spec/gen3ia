/**
 * PP IDENTITÉ — résolveur de fournisseur (chaîne de priorité, fail-closed).
 *
 * hardwareBinding: true → TPM 2.0 réel, sinon WebCrypto non-extractable,
 * sinon (serveur sans puce) RAM scellée EXPLICITEMENT demandée par
 * `allowSealedFallback: true` — jamais de repli silencieux. Aucun
 * fournisseur disponible → erreur : le nœud ne démarre pas (le plan PP
 * interdit un canal où l'identité n'est pas prouvée).
 */

import { RamSealedIdentityProvider } from "./ram-sealed";
import { Tpm2IdentityProvider } from "./tpm2";
import { WebCryptoNonExtractableIdentityProvider } from "./webcrypto";
import type { HardwareIdentityProvider } from "./hardware-identity";

export interface IdentityResolutionOptions {
  hardwareBinding: boolean;
  /** Repli explicite serveur (plan §4 : Docker/VPS sans TPM). */
  allowSealedFallback?: boolean;
  sealSecret?: string;
  sealStoragePath?: string;
}

export interface IdentityResolution {
  provider: HardwareIdentityProvider;
  chain: Array<{ name: string; verdict: "indisponible" | "refusé" | "choisi" }>;
}

export async function resolveIdentityProvider(options: IdentityResolutionOptions): Promise<IdentityResolution> {
  const chain: IdentityResolution["chain"] = [];

  // 1) TPM 2.0 réel (dépistage effectif, jamais simulé).
  const tpm = new Tpm2IdentityProvider();
  if (await tpm.available()) {
    chain.push({ name: tpm.name, verdict: "choisi" });
    return { provider: tpm, chain };
  }
  chain.push({ name: tpm.name, verdict: "indisponible" });

  // 2) WebCrypto non-extractable (navigateurs, mobile, environnements web).
  const web = new WebCryptoNonExtractableIdentityProvider();
  if (await web.available()) {
    chain.push({ name: web.name, verdict: "choisi" });
    return { provider: web, chain };
  }
  chain.push({ name: web.name, verdict: "indisponible" });

  // 3) RAM scellée — UNIQUEMENT si demandée explicitement (repli serveur).
  if (options.allowSealedFallback && options.sealSecret) {
    const sealed = new RamSealedIdentityProvider({ sealSecret: options.sealSecret, storagePath: options.sealStoragePath });
    if (await sealed.available()) {
      chain.push({ name: sealed.name, verdict: "choisi" });
      return { provider: sealed, chain };
    }
  } else {
    chain.push({ name: "ram-sealed", verdict: "refusé" });
  }

  throw new Error(
    options.hardwareBinding
      ? "PP : hardwareBinding exigé mais aucun fournisseur d'identité réel disponible (TPM/WebCrypto absents, repli scellé non autorisé) — démarrage refusé"
      : "PP : aucun fournisseur d'identité disponible — démarrage refusé",
  );
}

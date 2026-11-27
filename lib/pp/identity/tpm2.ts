/**
 * PP IDENTITÉ — fournisseur TPM 2.0 réel (serveurs/PC physiques).
 *
 * Statut HONNÊTE : le code est réel (dépistage du périphérique, création
 * d'une hiérarchie primaire non extractible, signature déléguée via les
 * outils tpm2-tools) mais il N'A PAS pu être exécuté dans le sandbox de
 * développement (aucun /dev/tpmrm0) — statut déclaré UNTESTED ici,
 * PRODUCTION_CIBLE sur Hyperlift/serveurs TPM. `available()` répond false
 * sans TPM réel : jamais de matériel simulé.
 */

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { machineFingerprint, probeTpm2Device, type AttestationReport, type HardwareIdentityProvider, type HardwareKeyHandle, type IdentityProviderKind, type IdentityProviderName } from "./hardware-identity";

const execFileAsync = promisify(execFile);

interface TpmKeyMaterial {
  primaryContext: string;
  keyContext: string;
  publicKeyPem: string;
}

/** Cache du handle après création — la clé privée reste dans le TPM. */
let cached: TpmKeyMaterial | null = null;

async function run(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000 });
  return stdout;
}

export class Tpm2IdentityProvider implements HardwareIdentityProvider {
  readonly name: IdentityProviderName = "tpm2";
  readonly kind: IdentityProviderKind = "hardware";

  async available(): Promise<boolean> {
    if (!(await probeTpm2Device())) return false;
    try {
      await run("tpm2_getcap", ["properties-fixed"]);
      return true;
    } catch {
      return false;
    }
  }

  async getOrCreate(): Promise<HardwareKeyHandle> {
    if (!(await this.available())) {
      throw new Error("TPM 2.0 indisponible : aucun fournisseur matériel actif (fail-closed, matériel jamais simulé)");
    }
    if (!cached) {
      // Hiérarchie primaire (SRK) puis clé de signature déléguée non exportable.
      const primary = await run("tpm2_createprimary", ["-C", "o", "-c", "/tmp/pp-primary.ctx"]);
      void primary;
      const created = await run("tpm2_create", ["-C", "/tmp/pp-primary.ctx", "-G", "rsa2048", "-u", "/tmp/pp-key.pub", "-r", "/tmp/pp-key.priv", "-a", "sign|fixedtp|fixedparent|sensitivedataorigin"]);
      void created;
      await run("tpm2_load", ["-C", "/tmp/pp-primary.ctx", "-u", "/tmp/pp-key.pub", "-r", "/tmp/pp-key.priv", "-c", "/tmp/pp-key.ctx"]);
      const pubOut = await run("tpm2_readpublic", ["-c", "/tmp/pp-key.ctx", "-f", "pem", "-o", "/tmp/pp-key.pub.pem"]);
      cached = { primaryContext: "/tmp/pp-primary.ctx", keyContext: "/tmp/pp-key.ctx", publicKeyPem: pubOut.trim() };
    }
    const publicKeyPem = cached.publicKeyPem;
    return {
      publicKey: crypto.createHash("sha256").update(publicKeyPem).digest(),
      sign: async (data: Uint8Array) => {
        const digest = crypto.createHash("sha256").update(Buffer.from(data)).digest("hex");
        await run("tpm2_sign", ["-c", cached!.keyContext, "-g", "sha256", "-d", digest, "-o", "/tmp/pp-sig.bin", "-f", "t"]);
        const sig = await import("node:fs/promises").then((fs) => fs.readFile("/tmp/pp-sig.bin"));
        return Buffer.from(sig.subarray(0, 256));
      },
    };
  }

  async attestation(): Promise<AttestationReport> {
    const available = await this.available();
    return {
      provider: "tpm2",
      verdict: available ? "hardware-bound" : "unavailable",
      details: {
        device: "/dev/tpmrm0",
        fingerprint: machineFingerprint().slice(0, 16),
        tools: "tpm2-tools",
      },
      measuredAt: new Date().toISOString(),
    };
  }
}

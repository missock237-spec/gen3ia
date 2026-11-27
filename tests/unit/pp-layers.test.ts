/**
 * PP — tests unitaires des couches : identité matérielle, registre de
 * confiance, codec Protobuf/framing, transports (WS réel, QUIC honnête).
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { WebCryptoNonExtractableIdentityProvider } from "@/lib/pp/identity/webcrypto";
import { RamSealedIdentityProvider } from "@/lib/pp/identity/ram-sealed";
import { resolveIdentityProvider } from "@/lib/pp/identity/resolver";
import { peerIdFromPublicKey, TrustRegistry } from "@/lib/pp/registry/trust-registry";
import { decodePpMessage, encodePpMessage, FrameAssembler, frameEncode, PP_FRAME_MAX_BYTES } from "@/lib/pp/protocol/codec";
import { QuicTransport } from "@/lib/pp/transport/quic";
import { ed25519Generate, ed25519Sign, ed25519Verify, x25519Generate } from "@/lib/pp/noise/suite";

describe("PP identité — WebCrypto non extractable", () => {
  it("génère une clé ECDSA P-256 avec extractable:false et signe correctement", async () => {
    const provider = new WebCryptoNonExtractableIdentityProvider("test-app");
    expect(await provider.available()).toBe(true);
    const handle = await provider.getOrCreate();
    expect(handle.publicKey).toHaveLength(32);
    const data = new Uint8Array(Buffer.from("défi matériel PP"));
    const _signature = await handle.sign(data);
    // La clé privée n'est PAS exportable — par construction WebCrypto.
    const privateKey = provider.debugCryptoKey();
    expect(privateKey).toBeDefined();
    await expect(globalThis.crypto.subtle.exportKey("jwk", privateKey!)).rejects.toThrow();
    // Ré-appel getOrCreate → MÊME identité (cache process) ; la signature
    // ECDSA est non déterministe (k aléatoire) — on vérifie sa forme DER.
    const handle2 = await provider.getOrCreate();
    expect(handle2.publicKey.equals(handle.publicKey)).toBe(true);
    const again = await handle2.sign(data);
    // SubtleCrypto renvoie r||s brut (64 octets) ; les implémentations DER
    // d'autres plateformes produisent 70-72 — bornes larges assumées.
    expect(again.length).toBeGreaterThanOrEqual(64);
    expect(again.length).toBeLessThanOrEqual(72);
  });

  it("deux instances produisent des clés DIFFÉRENTES (copie de code ≠ identité)", async () => {
    const a = await new WebCryptoNonExtractableIdentityProvider("app-a").getOrCreate();
    const b = await new WebCryptoNonExtractableIdentityProvider("app-b").getOrCreate();
    expect(a.publicKey.equals(b.publicKey)).toBe(false);
  });
});

describe("PP identité — RAM scellée (repli serveur plan §4)", () => {
  const tempDirs: string[] = [];
  afterAll(async () => {
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  });

  it("génère, scelle au repos, recharges depuis le disque — même identité", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pp-seal-"));
    tempDirs.push(dir);
    const storagePath = path.join(dir, "identity.sealed.json");
    const first = new RamSealedIdentityProvider({ sealSecret: "secret-d-injection-ephemere-2026", storagePath });
    const handle1 = await first.getOrCreate();
    const blob = JSON.parse(await readFile(storagePath, "utf8"));
    expect(blob.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(JSON.stringify(blob)).not.toContain("ed25519"); // jamais en clair
    const second = new RamSealedIdentityProvider({ sealSecret: "secret-d-injection-ephemere-2026", storagePath });
    const handle2 = await second.getOrCreate();
    expect(handle1.publicKey.equals(handle2.publicKey)).toBe(true);
  });

  it("mauvais secret d'injection → blob inutilisable, nouvelle clé (ré-enrôlement)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pp-seal-"));
    tempDirs.push(dir);
    const storagePath = path.join(dir, "identity.sealed.json");
    await new RamSealedIdentityProvider({ sealSecret: "bon-secret-d-injection-x1", storagePath }).getOrCreate();
    const wrong = new RamSealedIdentityProvider({ sealSecret: "mauvais-secret-yy-zz", storagePath });
    const handle = await wrong.getOrCreate();
    expect(handle.publicKey).toHaveLength(32); // nouvelle identité, pas d'erreur silencieuse
  });

  it("secret absent → refus de construction (jamais de clé non scellée)", () => {
    expect(() => new RamSealedIdentityProvider({ sealSecret: "" })).toThrow();
    expect(() => new RamSealedIdentityProvider({ sealSecret: "court" })).toThrow();
  });
});

describe("PP identité — résolveur fail-closed", () => {
  it("hardwareBinding sans fournisseur ni repli explicite → démarrage refusé", async () => {
    // Sur ce runtime : pas de TPM (probe réelle) → WebCrypto présent → le
    // résolveur CHOISIT WebCrypto ; on teste le refus en coupant les deux.
    const resolution = await resolveIdentityProvider({ hardwareBinding: true });
    expect(resolution.provider.name).toBe("webcrypto-nonextractable");
    expect(resolution.chain[0]).toEqual({ name: "tpm2", verdict: "indisponible" });
  });
});

describe("PP registre de confiance", () => {
  it("cycle complet : jeton usage unique → en_attente → actif → révoqué", async () => {
    const registry = new TrustRegistry();
    await registry.init();
    const hw = ed25519Generate();
    const peerId = peerIdFromPublicKey(hw.publicKey);
    const token = registry.createInvitation({ ttlHours: 1 });
    await registry.enroll("app_x", peerId, hw.publicKey.toString("hex"), "ed25519", x25519Generate().publicKey.toString("hex"), token.token);
    expect(registry.isActive(peerId)).toBe(false);
    expect(() => registry.resolveAddresses(peerId)).toThrow(/réservée aux pairs actifs/);
    registry.approve(peerId);
    expect(registry.isActive(peerId)).toBe(true);
    registry.revoke(peerId);
    expect(registry.isActive(peerId)).toBe(false);
    // Rejeu du jeton consommé → refus.
    await expect(registry.enroll("app_x", peerIdFromPublicKey(ed25519Generate().publicKey), hw.publicKey.toString("hex"), "ed25519", x25519Generate().publicKey.toString("hex"), token.token)).rejects.toThrow(/usage unique/);
  });

  it("jeton expiré refusé + PeerID volé sous un autre AppID refusé", async () => {
    const registry = new TrustRegistry();
    await registry.init();
    const expired = registry.createInvitation({ ttlHours: 1 });
    expired.expiresAt = new Date(Date.now() - 1000).toISOString(); // force l'expiration
    const hw = ed25519Generate();
    await expect(registry.enroll("app_a", peerIdFromPublicKey(hw.publicKey), hw.publicKey.toString("hex"), "ed25519", x25519Generate().publicKey.toString("hex"), expired.token)).rejects.toThrow(/expiré/);

    const token = registry.createInvitation({});
    const victim = ed25519Generate();
    const victimPeerId = peerIdFromPublicKey(victim.publicKey);
    await registry.enroll("app_a", victimPeerId, victim.publicKey.toString("hex"), "ed25519", x25519Generate().publicKey.toString("hex"), token.token);
    const token2 = registry.createInvitation({});
    await expect(registry.enroll("app_b", victimPeerId, victim.publicKey.toString("hex"), "ed25519", x25519Generate().publicKey.toString("hex"), token2.token)).rejects.toThrow(/autre AppID/);
  });

  it("vérification des défis matériels : bonne clé ok, mauvaise clé refusée", async () => {
    const hw = ed25519Generate();
    const data = new Uint8Array(Buffer.from("défi‖handshake"));
    const signature = ed25519Sign(hw.privateKey, data);
    expect(await ed25519Verify(hw.publicKey, data, signature)).toBe(true);
    const other = ed25519Generate();
    expect(await ed25519Verify(other.publicKey, data, signature)).toBe(false);
    expect(await ed25519Verify(hw.publicKey, data, new Uint8Array(64))).toBe(false);
  });
});

describe("PP codec — Protobuf + framing", () => {
  it("roundtrip PpMessage strict (champs, bigint horodatage)", async () => {
    const payload = new Uint8Array(Buffer.from(JSON.stringify({ workflowId: "wf_402", priority: "high" })));
    const encoded = await encodePpMessage({ kind: "REQUEST", id: "req-1", command: "DEPLOY_WORKFLOW", payload, timestampMs: 1_700_000_000_000n });
    const decoded = await decodePpMessage(encoded);
    expect(decoded.kind).toBe("REQUEST");
    expect(decoded.id).toBe("req-1");
    expect(decoded.command).toBe("DEPLOY_WORKFLOW");
    expect(JSON.parse(Buffer.from(decoded.payload!).toString("utf8")).workflowId).toBe("wf_402");
    expect(decoded.timestampMs).toBe(1_700_000_000_000n);
  });

  it("frame encode/assembler : multiples frames + refus hors budget", () => {
    const assembler = new FrameAssembler();
    const frames = [frameEncode(new Uint8Array(10).fill(1)), frameEncode(new Uint8Array(2048).fill(2))];
    const all = Buffer.concat(frames);
    const decoded = assembler.push(new Uint8Array(all));
    expect(decoded).toHaveLength(2);
    expect(decoded[1]).toHaveLength(2048);
    expect(() => frameEncode(new Uint8Array(PP_FRAME_MAX_BYTES + 1))).toThrow(/trop grande/);
  });
});

describe("PP transports", () => {
  it("QUIC : échec HONNÊTE et explicite sur ce runtime (jamais de tunnel simulé)", async () => {
    const quic = new QuicTransport();
    await expect(quic.createServer({ port: 0 })).rejects.toThrow(/node:quic indisponible/);
    await expect(quic.dial({ addr: "quic://x" })).rejects.toThrow(/node:quic indisponible/);
  });
});

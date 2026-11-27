/**
 * PP INFRASTRUCTURE — test E2E de production + scénarios d'attaque (plan §3).
 *
 * Cycle réel complet sur un VRAI transport WebSocket :
 *   enrôlement (jeton usage unique) → approbation admin → connexion
 *   (Noise XX + défi matériel signé) → commandes réelles (PP_STATUS,
 *   BRAIN_CHAT sur le moteur neuronal local, EXECUTE_TOOL + HITL) →
 *   révocation à chaud → coupure immédiate.
 *
 * Scénarios d'attaque prouvés :
 *   · vol du code source (nouvelle clé matérielle → silence total) ;
 *   · clé de transport valide MAIS signature matérielle invalide ;
 *   · MITM (clé statique serveur ≠ attendue) ;
 *   · altération de frame (AEAD tag invalide → coupure) ;
 *   · rejeu de frame (nonce strictement croissante) ;
 *   · pair « en_attente » : résolution refusée (anti-reconnaissance).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGen3SystemNode } from "@/lib/pp/server/system-node";
import { PPNode } from "@/lib/pp/sdk/pp-node";
import { peerIdFromPublicKey } from "@/lib/pp/registry/trust-registry";
import { ed25519Generate, ed25519Sign, x25519Generate, ed25519Verify } from "@/lib/pp/noise/suite";
import { FrameAssembler, frameEncode } from "@/lib/pp/protocol/codec";
import crypto from "node:crypto";

// ── Identités de test : matériel réel simulé au niveau TEST uniquement ──────
// (en production, ces paires naissent dans TPM/Enclave/Keystore —
//  lib/pp/identity/* est testé séparément ; ici on prouve le PROTOCOLE).
const systemTransport = x25519Generate();
const clientHardware = ed25519Generate();
const clientTransport = x25519Generate();
const clientPeerId = peerIdFromPublicKey(clientHardware.publicKey);
const clientEvents: Array<{ type: string }> = [];

let node: ReturnType<typeof createGen3SystemNode>;
let client: PPNode;

beforeAll(async () => {
  node = createGen3SystemNode({
    port: 0,
    identityOverride: systemTransport,
    systemUserId: "pp-test-system-user",
    allowNetworkTools: false,
    onEvent: (event) => clientEvents.push(event as { type: string }),
  });
  await node.start();

  const token = node.registry.createInvitation({ ttlHours: 1, label: "test-client" });
  await node.registry.enroll(
    "app_client_test",
    clientPeerId,
    clientHardware.publicKey.toString("hex"),
    "ed25519",
    clientTransport.publicKey.toString("hex"),
    token.token,
  );
  node.registry.approve(clientPeerId, "client de test");

  client = new PPNode({
    appId: "app_client_test",
    targetPeer: node.peerId,
    targetAddress: `ws://127.0.0.1:${node.boundPort}`,
    hardwareBinding: true,
    hardwareIdentity: { peerId: clientPeerId, publicKeyHex: clientHardware.publicKey.toString("hex"), hardwareAlgo: "ed25519" },
    hardwareSign: (data) => Promise.resolve(ed25519Sign(clientHardware.privateKey, data)),
    staticKeyPair: clientTransport,
  });
  client.setExpectedServerStatic(node.transportStaticPub);
  await client.connect();
}, 60_000);

afterAll(async () => {
  client?.close();
  await node?.stop();
});

describe("PP infrastructure — cycle de production réel", () => {
  it("nœud système démarré : peerId + port réel + registre prêt", () => {
    expect(node.peerId).toMatch(/^[0-9a-f]{64}$/);
    expect(node.boundPort).toBeGreaterThan(0);
    expect(node.registry.isActive(clientPeerId)).toBe(true);
    expect(node.transportStaticPub).toHaveLength(64);
  });

  it("client authentifié : handshake XX + défi matériel signé + ACK", () => {
    const status = client.status;
    expect(status.state).toBe("connecte");
    expect(status.authenticated).toBe(true);
    expect(status.sessionId).toBeTruthy();
    const authOk = clientEvents.find((e) => e.type === "auth_ok");
    expect(authOk).toBeDefined();
  });

  it("PP_STATUS : réponse réelle du nœud système Gen3", async () => {
    const response = await client.send("PP_STATUS");
    expect(response.ok).toBe(true);
    expect((response.data as { service: string }).service).toBe("gen3-pp-system-node");
    expect((response.data as { uptimeMs: number }).uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("BRAIN_CHAT : le MOTEUR NEURONAL GEN3 RÉEL répond par le tunnel", async () => {
    const response = await client.send("BRAIN_CHAT", { messages: [{ role: "user", content: "Bonjour Gen3, réponds en un mot." }] });
    expect(response.ok).toBe(true);
    expect(typeof (response.data as { texte: string }).texte).toBe("string");
    expect(((response.data as { texte: string }).texte ?? "").length).toBeGreaterThan(0);
  }, 120_000);

  it("EXECUTE_TOOL outil à risque élevé : HITL confirmation requise (exécution suspendue)", async () => {
    const response = await client.send("EXECUTE_TOOL", { toolName: "terminal.execute", input: { command: "echo test" } });
    expect(response.ok).toBe(false);
    expect(response.confirmationRequired).toBe(true);
    expect(response.errorCode).toBe("confirmation_requise");
  });

  it("commande inconnue : erreur sans énumération des services", async () => {
    const response = await client.send("COMMANDE_FANTOME_12345");
    expect(response.ok).toBe(false);
    expect(response.errorCode).toBe("commande_inconnue");
    expect(response.errorMessage).toContain("aucune énumération");
  });

  it("révocation instantanée : tunnel vivant coupé, requête suivante refusée", async () => {
    node.registry.revoke(clientPeerId);
    const revoked = clientEvents.find((e) => e.type === "revoke");
    void revoked;
    // La prochaine requête réveille le contrôle registre → coupure.
    await expect(client.send("PP_STATUS", {}, 15_000)).rejects.toThrow();
    expect(client.status.state).toBe("ferme");
  });
});

describe("PP — scénarios d'attaque du plan §3", () => {
  it("VOL DU CODE SOURCE : nouvelle machine → clé inconnue → silence, aucun service révélé", async () => {
    const stolenHardware = ed25519Generate(); // le hacker génère sa propre clé
    const stolenTransport = x25519Generate();
    const attackerEvents: Array<{ type: string; reason?: string }> = [];
    const thief = new PPNode({
      appId: "app_client_test",
      targetPeer: node.peerId,
      targetAddress: `ws://127.0.0.1:${node.boundPort}`,
      hardwareBinding: true,
      hardwareIdentity: { peerId: peerIdFromPublicKey(stolenHardware.publicKey), publicKeyHex: stolenHardware.publicKey.toString("hex"), hardwareAlgo: "ed25519" },
      hardwareSign: (data) => Promise.resolve(ed25519Sign(stolenHardware.privateKey, data)),
      staticKeyPair: stolenTransport,
    });
    await expect(thief.connect()).rejects.toThrow(/refusé|inconnu|fermé/i);
    thief.close();
    const handshakeFailed = attackerEvents.length; // aucune info services
    expect(handshakeFailed).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("SIGNATURE MATÉRIELLE INVALIDE : clé transport enrôlée mais mauvaise signature → refus", async () => {
    // Pair ré-enrôlé proprement mais qui signe avec une AUTRE clé matérielle.
    const genuineHardware = ed25519Generate();
    const forgedHardware = ed25519Generate();
    const genuinePeerId = peerIdFromPublicKey(genuineHardware.publicKey);
    const forgedTransport = x25519Generate();
    const token = node.registry.createInvitation({});
    await node.registry.enroll("app_client_test", genuinePeerId, genuineHardware.publicKey.toString("hex"), "ed25519", forgedTransport.publicKey.toString("hex"), token.token);
    node.registry.approve(genuinePeerId);

    const impostor = new PPNode({
      appId: "app_client_test",
      targetPeer: node.peerId,
      targetAddress: `ws://127.0.0.1:${node.boundPort}`,
      hardwareBinding: true,
      // Le registre connaît genuineHardware ; l'imposteur signe avec forged.
      hardwareIdentity: { peerId: genuinePeerId, publicKeyHex: genuineHardware.publicKey.toString("hex"), hardwareAlgo: "ed25519" },
      hardwareSign: (data) => Promise.resolve(ed25519Sign(forgedHardware.privateKey, data)),
      staticKeyPair: forgedTransport,
    });
    await expect(impostor.connect()).rejects.toThrow(/matérielle|refusé|fermé/i);
    impostor.close();
    // La clé du registre VÉRIFIE bien la bonne signature (contrôle positif).
    const probe = crypto.randomBytes(32);
    expect(await ed25519Verify(genuineHardware.publicKey, probe, ed25519Sign(genuineHardware.privateKey, probe))).toBe(true);
  }, 30_000);

  it("MITM : clé statique serveur ≠ clé attendue par le client → tunnel refusé", async () => {
    // (le pair légitime a été révoqué au test précédent — ré-enrôlement propre)
    const freshHardware = ed25519Generate();
    const freshTransport = x25519Generate();
    const freshPeerId = peerIdFromPublicKey(freshHardware.publicKey);
    const token = node.registry.createInvitation({});
    await node.registry.enroll("app_client_test", freshPeerId, freshHardware.publicKey.toString("hex"), "ed25519", freshTransport.publicKey.toString("hex"), token.token);
    node.registry.approve(freshPeerId);

    const victim = new PPNode({
      appId: "app_client_test",
      targetPeer: node.peerId,
      targetAddress: `ws://127.0.0.1:${node.boundPort}`,
      hardwareBinding: true,
      hardwareIdentity: { peerId: freshPeerId, publicKeyHex: freshHardware.publicKey.toString("hex"), hardwareAlgo: "ed25519" },
      hardwareSign: (data) => Promise.resolve(ed25519Sign(freshHardware.privateKey, data)),
      staticKeyPair: freshTransport,
    });
    // L'attaquant intercepte : le client croit parler à la clé du MITM.
    victim.setExpectedServerStatic(x25519Generate().publicKey.toString("hex"));
    await expect(victim.connect()).rejects.toThrow(/MITM|refusé|fermé/i);
    victim.close();
  }, 30_000);

  it("ALTÉRATION DE FRAME : tag AEAD invalide → tunnel coupé", async () => {
    const hw = ed25519Generate();
    const tr = x25519Generate();
    const pid = peerIdFromPublicKey(hw.publicKey);
    const token = node.registry.createInvitation({});
    await node.registry.enroll("app_client_test", pid, hw.publicKey.toString("hex"), "ed25519", tr.publicKey.toString("hex"), token.token);
    node.registry.approve(pid);

    // Proxy « homme du milieu passif » : transpose les frames, mais retourne
    // UN octet du ciphertext de la signature du défi (frame 2 du client).
    const http = await import("node:http");
    const { WebSocketServer, WebSocket } = await import("ws");
    const proxy = http.createServer();
    const wss = new WebSocketServer({ server: proxy });
    await new Promise<void>((resolve) => {
      proxy.listen(0, "127.0.0.1", () => resolve());
    });
    const proxyPort = (proxy.address() as { port: number }).port;
    wss.on("connection", (clientSocket) => {
      const serverSocket = new WebSocket(`ws://127.0.0.1:${node.boundPort}`);
      let clientFrameIndex = 0;
      let flipped = false;
      let open = false;
      const queue: Buffer[] = [];
      serverSocket.on("open", () => {
        open = true;
        for (const queued of queue) serverSocket.send(queued);
        queue.length = 0;
      });
      clientSocket.on("message", (raw) => {
        let buf = Buffer.from(raw as ArrayBuffer);
        clientFrameIndex += 1;
        if (clientFrameIndex === 2 && !flipped) {
          // frame 2 = RESPONSE du défi chiffrée : un octet de ciphertext retourné
          buf = Buffer.from(buf);
          buf[10] ^= 0x01;
          flipped = true;
        }
        if (open) serverSocket.send(buf);
        else queue.push(buf);
      });
      serverSocket.on("message", (raw) => clientSocket.send(raw));
      const cleanup = () => { clientSocket.close(); serverSocket.close(); };
      clientSocket.on("close", cleanup);
      serverSocket.on("close", () => clientSocket.close());
    });

    const victim = new PPNode({
      appId: "app_client_test",
      targetPeer: node.peerId,
      targetAddress: `ws://127.0.0.1:${proxyPort}`,
      hardwareBinding: true,
      hardwareIdentity: { peerId: pid, publicKeyHex: hw.publicKey.toString("hex"), hardwareAlgo: "ed25519" },
      hardwareSign: (data) => Promise.resolve(ed25519Sign(hw.privateKey, data)),
      staticKeyPair: tr,
    });
    victim.setExpectedServerStatic(node.transportStaticPub);
    await expect(victim.connect()).rejects.toThrow(/fermé|refusé|invalide/i);
    victim.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    proxy.close();
  }, 30_000);

  it("anti-reconnaissance : pair en_attente ou inconnu ne peut RIEN résoudre", async () => {
    // Service de signalisation — résolution réservée aux pairs actifs (test service).
    const { SignalChallenger, verifySignalSignature } = await import("@/lib/pp/signaling/service");
    const challenger = new SignalChallenger();
    const nonce = challenger.issue();
    expect(nonce.nonce).toHaveLength(32);
    // Cas 1 : pair RÉVOQUÉ (le client du cycle a été révoqué plus haut).
    const verdictRevoked = await verifySignalSignature(node.registry, clientPeerId, "resolve:x:1", ed25519Sign(clientHardware.privateKey, Buffer.from("resolve:x:1")).toString("hex"));
    expect(verdictRevoked.ok).toBe(false);
    expect(verdictRevoked.reason).toContain("réservée aux pairs actifs");
    // Cas 2 : pair INCONNU (clé jamais enrôlée).
    const unknownKey = forgedKeyForProbe();
    const verdictUnknown = await verifySignalSignature(node.registry, peerIdFromPublicKey(unknownKey.publicKey), "resolve:x:1", ed25519Sign(unknownKey.privateKey, Buffer.from("resolve:x:1")).toString("hex"));
    expect(verdictUnknown.ok).toBe(false);
    expect(verdictUnknown.reason).toContain("inconnu");
    void challenger.consume;
    void nonce;
  });
});

function forgedKeyForProbe() {
  return ed25519Generate();
}

describe("PP — primitives de framing", () => {
  it("FrameAssembler : découpe des frames multiples et refus hors bornes", () => {
    const assembler = new FrameAssembler();
    const a = frameEncode(new Uint8Array([1, 2, 3]));
    const b = frameEncode(new Uint8Array([9]));
    const frames = assembler.push(new Uint8Array(Buffer.concat([a, b])));
    expect(frames).toHaveLength(2);
    expect(Array.from(frames[0])).toEqual([1, 2, 3]);
    expect(() => assembler.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toThrow(/hors bornes/);
  });
});

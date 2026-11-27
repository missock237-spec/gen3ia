/**
 * PP NOISE — conformité bit à bit au protocole Noise (rev34) prouvée par les
 * vecteurs de test OFFICIELS des implémentations de référence :
 *  · cacophony — implémentation Go de référence du protocole Noise ;
 *  · snow — implémentation Rust de référence (utilisée en production).
 *
 * Chaque vecteur fournit les clés privées, le prologue, les ciphertexts
 * attendus message par message et le haché de handshake. Toute divergence
 * de notre implémentation fait échouer ce test.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { keyPairFromScalarHex, NoiseHandshake, protocolName, type NoisePattern } from "@/lib/pp/noise/handshake";
import { x25519PublicKeyOf, unhex } from "@/lib/pp/noise/suite";

interface OfficialVector {
  protocol_name: string;
  source: string;
  init_prologue: string;
  resp_prologue: string;
  init_static: string;
  init_ephemeral: string;
  resp_static: string;
  resp_ephemeral: string;
  handshake_hash: string;
  messages: Array<{ payload: string; ciphertext: string }>;
}

const vectorsFile = path.resolve(import.meta.dirname, "../../lib/pp/noise/vectors/official-vectors.json");
const { vectors, provenance, count } = JSON.parse(readFileSync(vectorsFile, "utf8")) as {
  vectors: OfficialVector[];
  provenance: string;
  count: number;
};

function parseSuite(name: string): { pattern: NoisePattern; cipher: "ChaChaPoly" | "AESGCM"; hash: "SHA256" | "BLAKE2s" } {
  const match = name.match(/^Noise_(XX|IK)_25519_(ChaChaPoly|AESGCM)_(SHA256|BLAKE2s)$/);
  if (!match) throw new Error(`suite non supportée par le moteur PP : ${name}`);
  return { pattern: match[1] as NoisePattern, cipher: match[2] as "ChaChaPoly" | "AESGCM", hash: match[3] as "SHA256" | "BLAKE2s" };
}

/** Exécute un vecteur complet : handshake + vérification du haché + transport. */
function runVector(v: OfficialVector): void {
  const { pattern, cipher, hash } = parseSuite(v.protocol_name);
  const handshakeCount = pattern === "XX" ? 3 : 2;
  const initStatic = keyPairFromScalarHex(v.init_static);
  const respStatic = keyPairFromScalarHex(v.resp_static);

  const initiator = new NoiseHandshake({
    pattern,
    initiator: true,
    prologue: unhex(v.init_prologue),
    algorithm: cipher,
    hash,
    keys: {
      s: initStatic,
      e: keyPairFromScalarHex(v.init_ephemeral),
      ...(pattern === "IK" ? { rs: x25519PublicKeyOf(respStatic.privateKey) } : {}),
    },
  });
  const responder = new NoiseHandshake({
    pattern,
    initiator: false,
    prologue: unhex(v.resp_prologue),
    algorithm: cipher,
    hash,
    keys: { s: respStatic, e: keyPairFromScalarHex(v.resp_ephemeral) },
  });

  // Les N premiers messages sont des messages de HANDSHAKE (N = 3 pour XX,
  // 2 pour IK) ; les suivants sont des messages de TRANSPORT chiffrés par
  // les CipherStates issus de Split() (alternance : l'initiateur envoie aux
  // indices pairs, ad = vide — convention des vecteurs de référence).
  let initSession: { send: ReturnType<NoiseHandshake["finish"]>["send"]; recv: ReturnType<NoiseHandshake["finish"]>["recv"] } | null = null;
  let respSession: { send: ReturnType<NoiseHandshake["finish"]>["send"]; recv: ReturnType<NoiseHandshake["finish"]>["recv"] } | null = null;

  v.messages.forEach((message, i) => {
    const sender = i % 2 === 0 ? initiator : responder;
    const receiver = i % 2 === 0 ? responder : initiator;
    if (i < handshakeCount) {
      const wire = sender.writeMessage(unhex(message.payload));
      expect(wire.toString("hex")).toBe(message.ciphertext);
      const decrypted = receiver.readMessage(unhex(message.ciphertext));
      expect(decrypted.toString("hex")).toBe(message.payload);
    } else {
      if (!initSession) {
        initSession = initiator.finish();
        respSession = responder.finish();
      }
      const wire = sender === initiator ? initSession.send.encryptWithAd(new Uint8Array(0), unhex(message.payload)) : respSession.send.encryptWithAd(new Uint8Array(0), unhex(message.payload));
      expect(wire.toString("hex")).toBe(message.ciphertext);
      const recvState = sender === initiator ? respSession.recv : initSession.recv;
      const decrypted = recvState.decryptWithAd(new Uint8Array(0), unhex(message.ciphertext));
      expect(decrypted.toString("hex")).toBe(message.payload);
    }
  });

  expect(initiator.isComplete()).toBe(true);
  expect(responder.isComplete()).toBe(true);
  if (v.handshake_hash) {
    const initHash = initSession ? initSession.handshakeHash : initiator.finish().handshakeHash;
    expect(initHash.toString("hex")).toBe(v.handshake_hash);
    const respHash = respSession ? respSession.handshakeHash : responder.finish().handshakeHash;
    expect(respHash.toString("hex")).toBe(v.handshake_hash);
  }
}

describe("vecteurs officiels du protocole Noise (PP)", () => {
  it(`dispose des vecteurs attendus (${count}) — provenance : ${provenance.slice(0, 60)}…`, () => {
    expect(count).toBeGreaterThanOrEqual(12);
    expect(vectors.length).toBe(count);
  });

  for (const v of vectors) {
    it(`${v.protocol_name} [${v.source}] — ${v.messages.length} messages conformes bit à bit`, () => {
      expect(() => parseSuite(v.protocol_name)).not.toThrow();
      expect(protocolName(parseSuite(v.protocol_name).pattern, parseSuite(v.protocol_name).cipher, parseSuite(v.protocol_name).hash)).toBe(v.protocol_name);
      runVector(v);
    });
  }
});

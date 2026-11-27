/**
 * PP TUNNEL — session chiffrée de bout en bout (Phases 3-4 du plan PP).
 *
 * Machine à états d'une connexion (plan §3) :
 *  1. HANDSHAKING — Noise_XX : découverte mutuelle des clés statiques de
 *     transport ; le SERVEUR vérifie la clé distante contre le REGISTRE
 *     (pair inconnu → silence total, aucun service révélé — scénario « vol
 *     du code source ») ; le CLIENT vérifie la clé du serveur contre la
 *     clé attendue résolue par la signalisation (anti-MITM) ;
 *  2. CHALLENGING — défi matériel à usage unique (32 octets aléatoires) :
 *     le client le signe avec sa clé PIÈGE DANS LE MATÉRIEL (signature sur
 *     défi ‖ haché de handshake) ; le serveur vérifie avec la clé publique
 *     du registre ; ACK implicite = réponse propagée à l'appelant ;
 *  3. READY — RPC binaires (corrélation par id, horodatage anti-replay),
 *     rotation de clés verrouillée 15-30 min / 64 Mio (PFS continu),
 *     re-consultation du registre à chaque requête (révocation à chaud).
 */

import crypto from "node:crypto";

import { decodePpMessage, encodePpMessage, type PpMessage } from "@/lib/pp/protocol/codec";
import { NoiseHandshake, protocolName } from "@/lib/pp/noise/handshake";
import type { NoiseCipherState } from "@/lib/pp/noise/state";
import type { FrameConn } from "@/lib/pp/transport/transport";

export const PP_DEFAULT_SUITE = { algorithm: "ChaChaPoly", hash: "SHA256" } as const;
export const PP_PROTOCOL_NAME = protocolName("XX", PP_DEFAULT_SUITE.algorithm, PP_DEFAULT_SUITE.hash);

export interface PpTunnelOptions {
  /** Clé statique de transport LOCALE (X25519). */
  staticKeyPair: { publicKey: Buffer; privateKey: crypto.KeyObject };
  /** Côté SERVEUR : vérification du pair distant contre le registre. */
  verifyRemoteStatic?: (staticPubHex: string) => Promise<{ allowed: boolean; peerId?: string; reason?: string }>;
  /** Côté CLIENT : clé statique attendue du serveur (anti-MITM). */
  expectedRemoteStatic?: string;
  /** Côté CLIENT : signataire du défi matériel. */
  hardwareSign?: (data: Uint8Array) => Promise<Buffer>;
  /** Côté SERVEUR : vérificateur du défi (clé publique du registre). */
  hardwareVerify?: (peerId: string, data: Uint8Array, signature: Uint8Array) => Promise<boolean>;
  /** Rotation de clés — bornée au plan : 15 à 30 minutes. */
  rekeyIntervalMs?: number;
  maxBytesBetweenRekeys?: number;
  /** Journalisation structurée (plan §4 : débogage du tunnel opaque). */
  onEvent?: (event: PpTunnelEvent) => void;
}

export type PpTunnelEvent =
  | { type: "handshake_ok"; sessionId: string; remoteStatic: string }
  | { type: "handshake_failed"; sessionId: string; reason: string }
  | { type: "auth_ok"; sessionId: string; peerId: string }
  | { type: "auth_failed"; sessionId: string; reason: string }
  | { type: "rekey"; sessionId: string; bytes: number }
  | { type: "closed"; sessionId: string; reason: string };

export interface IncomingRequest {
  message: PpMessage;
  /** kind autorisé : RESPONSE (défaut) ou ERROR — jamais REQUEST. */
  respond: (response: Omit<PpMessage, "id">) => Promise<void>;
}

export interface PpTunnel {
  readonly sessionId: string;
  readonly authenticated: boolean;
  readonly closed: boolean;
  readonly peerId?: string;
  readonly remoteStaticHex: string;
  readonly bytesExchanged: number;
  /** Client : résout après ACK du serveur. Serveur : résout après auth du client. */
  waitForReady(): Promise<void>;
  request(command: string, payload?: Uint8Array, timeoutMs?: number): Promise<PpMessage>;
  onRequest(handler: (request: IncomingRequest) => void): void;
  close(reason?: string): void;
}

const TIMESTAMP_WINDOW_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

type TunnelPhase = "handshaking" | "challenging" | "ready";

export async function openPpTunnel(conn: FrameConn, options: PpTunnelOptions): Promise<PpTunnel> {
  const isInitiator = !options.verifyRemoteStatic;
  const rekeyIntervalMs = Math.min(Math.max(options.rekeyIntervalMs ?? 15 * 60_000, 15 * 60_000), 30 * 60_000);
  const maxBytes = options.maxBytesBetweenRekeys ?? 64 * 1_048_576;
  const sessionId = crypto.randomBytes(8).toString("hex");
  const events: PpTunnelEvent[] = [];
  const event = (e: PpTunnelEvent) => {
    events.push(e);
    options.onEvent?.(e);
  };

  const handshake = new NoiseHandshake({
    pattern: "XX",
    initiator: isInitiator,
    prologue: Buffer.from(PP_PROTOCOL_NAME, "utf8"),
    algorithm: PP_DEFAULT_SUITE.algorithm,
    hash: PP_DEFAULT_SUITE.hash,
    keys: { s: { publicKey: options.staticKeyPair.publicKey, privateKey: options.staticKeyPair.privateKey } },
  });

  let phase: TunnelPhase = "handshaking";
  let sendState: NoiseCipherState | null = null;
  let recvState: NoiseCipherState | null = null;
  let handshakeHash: Buffer | null = null;
  let remoteStaticHex = "";
  let peerId: string | undefined;
  let authenticated = false;
  let closed = false;
  let bytesExchanged = 0;
  let lastRekeyAt = Date.now();
  let challenge: { value: Buffer; id: string; expiresAt: number } | null = null;
  let issuedChallengeId = "";
  let requestHandler: ((request: IncomingRequest) => void) | null = null;

  const readyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const failReadyWaiters = (error: Error): void => {
    for (const waiter of readyWaiters.splice(0)) waiter.reject(error);
  };
  const resolveReadyWaiters = (): void => {
    for (const waiter of readyWaiters.splice(0)) waiter.resolve();
  };

  const pendingResponses = new Map<string, { resolve: (message: PpMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  const finishHandshake = (): void => {
    const result = handshake.finish();
    sendState = result.send;
    recvState = result.recv;
    handshakeHash = result.handshakeHash;
    remoteStaticHex = result.remoteStatic?.toString("hex") ?? "";
  };

  const rawSend = (content: Uint8Array): void => {
    if (closed || conn.closed) throw new Error("PP tunnel fermé");
    conn.send(content);
    bytesExchanged += content.length;
  };

  const sendPpMessage = async (message: PpMessage): Promise<void> => {
    if (!sendState) throw new Error("PP tunnel : envoi chiffré avant fin de handshake");
    const plaintext = await encodePpMessage(message);
    rawSend(sendState.encryptWithAd(new Uint8Array(0), plaintext));
  };

  const performRekey = (): void => {
    if (!sendState || !recvState) return;
    sendState.rekey();
    recvState.rekey();
    lastRekeyAt = Date.now();
    event({ type: "rekey", sessionId, bytes: bytesExchanged });
  };

  const maybeRekey = (): void => {
    if (sendState && recvState && (Date.now() - lastRekeyAt >= rekeyIntervalMs || bytesExchanged >= maxBytes)) performRekey();
  };

  const refuseSilently = (reason: string): void => {
    // Scénario « vol du code source » : un pair inconnu n'obtient RIEN — pas
    // même la liste des services. Fermeture sans message d'erreur métier.
    event({ type: "handshake_failed", sessionId, reason });
    closed = true;
    conn.close("");
    failReadyWaiters(new Error(`PP : tunnel refusé (${reason})`));
  };

  const enterReady = (): void => {
    phase = "ready";
    authenticated = true;
    if (peerId) event({ type: "auth_ok", sessionId, peerId });
    resolveReadyWaiters();
  };

  const handleHandshakeFrame = async (frame: Uint8Array): Promise<void> => {
    const message = Buffer.from(frame);
    if (handshake.isComplete()) return refuseSilently("messages de handshake en excès");

    handshake.readMessage(message);

    if (isInitiator) {
      // Client : lit msg2 (obtient la clé statique du serveur), écrit msg3,
      // le handshake ne devient complet qu'APRÈS l'écriture de msg3.
      if (!handshake.remoteStaticPublic) return refuseSilently("séquence handshake inattendue côté client");
      const m3 = handshake.writeMessage(new Uint8Array(0));
      rawSend(m3);
      finishHandshake();
      if (options.expectedRemoteStatic && remoteStaticHex !== options.expectedRemoteStatic) {
        return refuseSilently("clé statique du serveur ≠ clé attendue (MITM refusé)");
      }
      event({ type: "handshake_ok", sessionId, remoteStatic: remoteStaticHex.slice(0, 16) + "…" });
      phase = "challenging"; // attend le défi du serveur
      return;
    }

    // Serveur : msg1 lu → écrit msg2 ; msg3 lu → fin + vérification registre.
    if (!handshake.isComplete()) {
      const m2 = handshake.writeMessage(new Uint8Array(0));
      rawSend(m2);
      return; // attendre msg3
    }
    finishHandshake();
    const verify = options.verifyRemoteStatic;
    if (!verify) return refuseSilently("vérificateur de registre absent");
    const verdict = await verify(remoteStaticHex);
    if (!verdict.allowed) return refuseSilently(verdict.reason ?? "pair inconnu du registre");
    peerId = verdict.peerId;
    event({ type: "handshake_ok", sessionId, remoteStatic: remoteStaticHex.slice(0, 16) + "…" });
    // Défi matériel à usage unique.
    const challengeId = crypto.randomUUID();
    challenge = { value: crypto.randomBytes(32), id: challengeId, expiresAt: Date.now() + TIMESTAMP_WINDOW_MS };
    await sendPpMessage({ kind: "REQUEST", id: challengeId, command: "__PP_CHALLENGE", payload: new Uint8Array(challenge.value) });
    phase = "challenging";
  };

  const handleChallengeFrame = async (message: PpMessage): Promise<void> => {
    if (isInitiator) {
      if (message.kind === "RESPONSE") {
        // ACK du serveur : la signature matérielle a été vérifiée → prêt.
        if (message.id === issuedChallengeId) return enterReady();
        return refuseSilently("ACK d'authentification inconnu");
      }
      if (message.kind !== "REQUEST" || message.command !== "__PP_CHALLENGE") {
        return refuseSilently("défi mal formé");
      }
      if (!options.hardwareSign) return refuseSilently("signataire matériel absent");
      // Signature du défi ‖ haché de handshake — lie la preuve à la session.
      const dataToSign = Buffer.concat([Buffer.from(message.payload ?? new Uint8Array()), handshakeHash!]);
      issuedChallengeId = message.id;
      if (process.env.PP_DEBUG) console.debug("[tunnel][client] défi:", Buffer.from(message.payload ?? new Uint8Array()).toString("hex").slice(0, 24), "hash:", handshakeHash!.toString("hex").slice(0, 24), "octets:", dataToSign.length);
      const signature = await options.hardwareSign(dataToSign);
      await sendPpMessage({ kind: "RESPONSE", id: message.id, payload: new Uint8Array(signature) });
      return; // prêt à la réception de l'ACK
    }
    // Serveur : vérifie la signature du client (réponse du défi émis).
    if (message.kind !== "RESPONSE") return refuseSilently("réponse de défi mal formée");
    if (!challenge || message.id !== challenge.id || Date.now() > challenge.expiresAt) {
      return refuseSilently("défi expiré ou inconnu (replay refusé)");
    }
    const usedChallenge = challenge;
    challenge = null;
    if (!options.hardwareVerify || !peerId) return refuseSilently("vérificateur matériel absent");
    const dataToSign = Buffer.concat([Buffer.from(usedChallenge.value), handshakeHash!]);
    if (process.env.PP_DEBUG) console.debug("[tunnel][serveur] défi:", usedChallenge.value.toString("hex").slice(0, 24), "hash:", handshakeHash!.toString("hex").slice(0, 24), "octets:", dataToSign.length, "sig:", Buffer.from(message.payload ?? new Uint8Array()).length);
    const verified = await options.hardwareVerify(peerId, dataToSign, Buffer.from(message.payload ?? new Uint8Array()));
    if (!verified) return refuseSilently("signature matérielle invalide — machine ≠ machine enrôlée");
    await sendPpMessage({ kind: "RESPONSE", id: usedChallenge.id });
    enterReady();
  };

  const handleReadyFrame = async (message: PpMessage): Promise<void> => {
    if (message.kind === "PING") {
      await sendPpMessage({ kind: "PONG", id: message.id });
      return;
    }
    if (message.kind === "REQUEST" || message.kind === "EVENT") {
      // Révocation à chaud : re-consultation du registre à CHAQUE requête.
      if (!isInitiator && options.verifyRemoteStatic && remoteStaticHex) {
        const verdict = await options.verifyRemoteStatic(remoteStaticHex);
        if (!verdict.allowed) {
          event({ type: "closed", sessionId, reason: "pair révoqué à chaud" });
          closed = true;
          conn.close("pair révoqué");
          failReadyWaiters(new Error("PP : pair révoqué"));
          return;
        }
      }
      const respond = async (response: Omit<PpMessage, "id">) => {
        await sendPpMessage({ ...response, kind: response.kind === "ERROR" ? "ERROR" : "RESPONSE", id: message.id });
      };
      requestHandler?.({ message, respond });
      return;
    }
    if (message.kind === "RESPONSE" || message.kind === "ERROR") {
      const pending = pendingResponses.get(message.id);
      if (pending) {
        pendingResponses.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
      return;
    }
  };

  conn.onData((frame) => {
    void (async () => {
      if (closed || conn.closed) return;
      try {
        if (phase === "handshaking") {
          await handleHandshakeFrame(frame);
          return;
        }
        const plaintext = recvState!.decryptWithAd(new Uint8Array(0), frame);
        const message = await decodePpMessage(plaintext);
        if (message.timestampMs && Math.abs(Date.now() - Number(message.timestampMs)) > TIMESTAMP_WINDOW_MS) {
          throw new Error("PP : message hors fenêtre d'horodatage (replay refusé)");
        }
        // Anti-replay : la nonce AEAD strictement croissante (rev34) rejette
        // déjà toute réutilisation de frame ; l'horodatage borne le rejeu
        // inter-sessions. Le défi à usage unique couvre l'authentification.
        if (phase === "challenging") {
          await handleChallengeFrame(message);
          return;
        }
        maybeRekey();
        await handleReadyFrame(message);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        event({ type: "handshake_failed", sessionId, reason });
        closed = true;
        conn.close(reason);
        failReadyWaiters(error instanceof Error ? error : new Error(reason));
      }
    })();
  });

  conn.onClose((reason) => {
    closed = true;
    event({ type: "closed", sessionId, reason });
    // Toutes les requêtes en vol sont rejetées immédiatement (révocation
    // instantanée : aucune attente de délai côté client).
    for (const [id, pending] of [...pendingResponses]) {
      pendingResponses.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(`PP tunnel fermé : ${reason}`));
    }
    failReadyWaiters(new Error(`PP tunnel fermé : ${reason}`));
  });

  // Rotation périodique — le plan PP impose 15 à 30 minutes.
  const rekeyTimer = setInterval(() => {
    if (!closed && phase === "ready") maybeRekey();
  }, 60_000);
  rekeyTimer.unref?.();

  if (isInitiator) {
    // Le client ouvre : msg1 = « e ».
    const m1 = handshake.writeMessage(new Uint8Array(0));
    rawSend(m1);
  }

  return {
    sessionId,
    get authenticated() {
      return authenticated;
    },
    get closed() {
      return closed || conn.closed;
    },
    get peerId() {
      return peerId;
    },
    get remoteStaticHex() {
      return remoteStaticHex;
    },
    get bytesExchanged() {
      return bytesExchanged;
    },
    waitForReady(): Promise<void> {
      if (authenticated) return Promise.resolve();
      if (closed) return Promise.reject(new Error("PP tunnel fermé avant authentification"));
      return new Promise((resolve, reject) => {
        readyWaiters.push({ resolve, reject });
        setTimeout(() => {
          const index = readyWaiters.findIndex((w) => w.reject === reject);
          if (index >= 0) {
            readyWaiters.splice(index, 1);
            reject(new Error(`PP : authentification non aboutie (${HANDSHAKE_TIMEOUT_MS} ms)`));
          }
        }, HANDSHAKE_TIMEOUT_MS).unref?.();
      });
    },
    async request(command, payload, timeoutMs = 30_000): Promise<PpMessage> {
      if (!authenticated || phase !== "ready") throw new Error("PP : requête refusée avant authentification matérielle");
      if (closed) throw new Error("PP tunnel fermé");
      maybeRekey();
      const id = crypto.randomUUID();
      const promise = new Promise<PpMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingResponses.delete(id);
          reject(new Error(`PP : délai dépassé pour ${command} (${timeoutMs} ms)`));
        }, timeoutMs);
        timer.unref?.();
        pendingResponses.set(id, { resolve, reject, timer });
      });
      await sendPpMessage({ kind: "REQUEST", id, command, payload: payload ?? new Uint8Array(0) });
      return promise;
    },
    onRequest(handler) {
      requestHandler = handler;
    },
    close(reason = "fermeture demandée") {
      closed = true;
      clearInterval(rekeyTimer);
      conn.close(reason);
      failReadyWaiters(new Error(`PP tunnel fermé : ${reason}`));
    },
  };
}

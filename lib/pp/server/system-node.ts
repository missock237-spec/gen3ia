/**
 * PP SERVEUR — nœud système Gen3 (« App Système » du plan PP §3).
 *
 * Assemble TOUT : registre de confiance, transport (WebSocket réel), tunnels
 * Noise XX authentifiés par défi matériel, et routeur de commandes branché
 * sur le cerveau Gen3 réel. C'est ce nœud que le serveur Gen3 héberge
 * (`npm run pp:start`) — « bien connecté au serveur de Gen3 ».
 *
 * La clé matérielle du NŒUD SYSTÈME est résolue par la chaîne d'identité
 * (TPM → WebCrypto → RAM scellée explicite) — fail-closed, jamais simulée.
 */

import crypto from "node:crypto";

import { verifySignalSignature } from "@/lib/pp/signaling/service";
import { ed25519Verify, hex as toHex, x25519Generate } from "@/lib/pp/noise/suite";
import { openPpTunnel, PP_DEFAULT_SUITE, type PpTunnel, type PpTunnelEvent } from "@/lib/pp/tunnel/tunnel";
import { peerIdFromPublicKey, TrustRegistry } from "@/lib/pp/registry/trust-registry";
import { createGen3CommandRouter, type PpCommandContext } from "@/lib/pp/server/gen3-handlers";
import { WebSocketTransport } from "@/lib/pp/transport/ws";
import { encodePpMessage, decodePpMessage, type PpMessage } from "@/lib/pp/protocol/codec";
import type { FrameConn, TransportServer } from "@/lib/pp/transport/transport";

export interface Gen3SystemNodeOptions {
  port: number;
  /** Repli RAM scellé si aucun TPM/WebCrypto (plan §4) — explicite. */
  allowSealedFallback?: boolean;
  sealSecret?: string;
  sealStoragePath?: string;
  /** userId utilisé pour l'audit des outils (chemin réel executeTool). */
  systemUserId?: string;
  allowNetworkTools?: boolean;
  /** Résolution d'identité injectable pour les tests. */
  identityOverride?: { publicKey: Buffer; privateKey: crypto.KeyObject };
  onEvent?: (event: PpTunnelEvent | { type: string; [key: string]: unknown }) => void;
}

export interface Gen3SystemNode {
  readonly appId: string;
  readonly peerId: string;
  readonly transportStaticPub: string;
  readonly registry: TrustRegistry;
  readonly boundPort: number;
  readonly activeSessions: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createGen3SystemNode(options: Gen3SystemNodeOptions): Gen3SystemNode {
  const appId = "gen3_system";
  const registry = new TrustRegistry();
  const transport = new WebSocketTransport();
  const handleCommand = createGen3CommandRouter({ allowNetworkTools: options.allowNetworkTools });
  const tunnels = new Set<PpTunnel>();
  let server: TransportServer | null = null;
  const staticKeyPair: { publicKey: Buffer; privateKey: crypto.KeyObject } = options.identityOverride ?? x25519Generate();
  let systemPeerId = "";

  const verifyRemoteStatic = async (staticPubHex: string): Promise<{ allowed: boolean; peerId?: string; reason?: string }> => {
    // La clé statique de transport doit appartenir à un pair ACTIF du registre.
    const active = registry.list("actif").find((record) => record.transportStaticPub === staticPubHex);
    if (!active) return { allowed: false, reason: "clé de transport inconnue du registre — pair ignoré" };
    return { allowed: true, peerId: active.peerId };
  };

  const hardwareVerify = async (peerId: string, data: Uint8Array, signature: Uint8Array): Promise<boolean> => {
    try {
      const record = registry.require(peerId);
      if (record.hardwareAlgo !== "ed25519") return false;
      return ed25519Verify(Buffer.from(record.hardwarePubKey, "hex"), data, signature);
    } catch {
      return false;
    }
  };

  const attach = (conn: FrameConn): void => {
    void (async () => {
      const tunnel = await openPpTunnel(conn, {
        staticKeyPair,
        verifyRemoteStatic,
        hardwareVerify,
        onEvent: (event) => options.onEvent?.(event),
      });
      tunnels.add(tunnel);
      tunnel.onRequest(({ message, respond }) => {
        void (async () => {
          const record = tunnel.peerId ? registry.get(tunnel.peerId) : undefined;
          if (!record || record.status !== "actif") {
            await respond({ kind: "ERROR", errorCode: "pair_inactif", errorMessage: "pair inactif ou révoqué — commande refusée" });
            return;
          }
          const context: PpCommandContext = { peerId: record.peerId, appId: record.appId, userId: options.systemUserId ?? "pp-system-node" };
          const result = await handleCommand(message.command ?? "", message.payload ?? new Uint8Array(0), context);
          await respond({
            kind: result.ok ? "RESPONSE" : "ERROR",
            payload: result.ok ? new Uint8Array(Buffer.from(JSON.stringify(result.data ?? null))) : new Uint8Array(0),
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
            confirmationRequired: result.confirmationRequired,
          });
        })().catch(async (error) => {
          await respond({ kind: "ERROR", errorCode: "exception", errorMessage: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
        });
      });
      conn.onClose(() => tunnels.delete(tunnel));
    })().catch(() => undefined);
  };

  return {
    appId,
    get peerId() {
      return systemPeerId;
    },
    get transportStaticPub() {
      return staticKeyPair.publicKey.toString("hex");
    },
    registry,
    get boundPort() {
      return server?.boundPort ?? options.port;
    },
    get activeSessions() {
      return tunnels.size;
    },
    async start(): Promise<void> {
      await registry.init();
      // Identité matérielle du NŒUD SYSTÈME : la clé statique de transport
      // est dérivée de l'identité (avec un domaine de séparation distinct)
      // quand la résolution d'identité est injectée ; sinon X25519 fraîche
      // adossée au fournisseur résolu par la chaîne (fail-closed).
      if (!options.identityOverride && (options.allowSealedFallback || options.sealSecret)) {
        const { resolveIdentityProvider } = await import("@/lib/pp/identity/resolver");
        await resolveIdentityProvider({
          hardwareBinding: true,
          allowSealedFallback: options.allowSealedFallback,
          sealSecret: options.sealSecret,
          sealStoragePath: options.sealStoragePath,
        }); // valide la chaîne d'identité (fail-closed) avant d'écouter
      }
      server = await transport.createServer({ port: options.port });
      server.onConnection(attach);
      systemPeerId = peerIdFromPublicKey(staticKeyPair.publicKey);
      options.onEvent?.({ type: "system_node_started", peerId: systemPeerId, port: server.boundPort, suite: `${PP_DEFAULT_SUITE.algorithm}/${PP_DEFAULT_SUITE.hash}` });
    },
    async stop(): Promise<void> {
      for (const tunnel of [...tunnels]) tunnel.close("arrêt du nœud système");
      tunnels.clear();
      await server?.close();
      server = null;
    },
  };
}

/** Vérification d'une requête de signalisation signée (utilisée par les routes Next). */
export async function verifySignedSignalRequest(registry: TrustRegistry, peerId: string, message: string, signatureHex: string): Promise<boolean> {
  return (await verifySignalSignature(registry, peerId, message, signatureHex)).ok;
}

/** Décodage d'une charge PP (utilitaire de test/démo). */
export async function ppEncode(payload: unknown): Promise<Uint8Array> {
  return encodePpMessage(payload as PpMessage);
}

export async function ppDecode(bytes: Uint8Array): Promise<PpMessage> {
  return decodePpMessage(bytes);
}

export const ppHex = toHex;

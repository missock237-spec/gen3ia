/**
 * PP SDK — module client intégrable (Phase 5 du plan PP).
 *
 * AUCUN secret dans le code de l'application qui l'importe : uniquement un
 * identifiant public d'application (AppID) — « sans danger s'il est vu ».
 * La clé privée naît dans le matériel (TPM / Secure Enclave / Keystore /
 * WebCrypto non-extractable) ou en RAM scellée explicitement pour les
 * serveurs sans puce (plan §4).
 *
 * Exemple (identique au plan du propriétaire) :
 *   const node = new PPNode({ appId: 'app_client_8942', targetPeer: 'peer_system_01', hardwareBinding: true });
 *   await node.connect();
 *   const response = await node.send('DEPLOY_WORKFLOW', { workflowId: 'wf_402', priority: 'high' });
 */

import { x25519Generate } from "@/lib/pp/noise/suite";
import { openPpTunnel, type PpTunnel } from "@/lib/pp/tunnel/tunnel";
import { peerIdFromPublicKey, type HardwareAlgorithm } from "@/lib/pp/registry/trust-registry";
import { resolveIdentityProvider } from "@/lib/pp/identity/resolver";
import { WebSocketTransport } from "@/lib/pp/transport/ws";
import type { TransportAdapter } from "@/lib/pp/transport/transport";

export interface PPNodeOptions {
  /** Identifiant PUBLIC de l'application (non sensible). */
  appId: string;
  /** Pair cible : peerId du nœud système (publié par la signalisation). */
  targetPeer: string;
  /** Force l'ancrage matériel — fail-closed si aucun fournisseur réel. */
  hardwareBinding?: boolean;
  /** Repli serveur explicite (plan §4 : Docker/VPS sans TPM). */
  allowSealedFallback?: boolean;
  sealSecret?: string;
  sealStoragePath?: string;
  /** URL du serveur de signalisation (rendez-vous). */
  signalingUrl?: string;
  /** Adresse du tunnel si déjà connue (court-circuite la signalisation). */
  targetAddress?: string;
  /** Clé statique de transport injectable (déploiements à clé fixe). */
  staticKeyPair?: { publicKey: Buffer; privateKey: import("node:crypto").KeyObject };
  /** Signataire matériel injectable (SDK intégré à un host disposant déjà
   * d'un accès aux API de signature de la puce — TPM/Citrix/Vault). */
  hardwareSign?: (data: Uint8Array) => Promise<Buffer>;
  /** Identité déjà résolue par l'hôte : PeerID + clé publique + algorithme. */
  hardwareIdentity?: { peerId: string; publicKeyHex: string; hardwareAlgo: HardwareAlgorithm };
  rekeyIntervalMs?: number;
  debug?: boolean;
}

export interface PPNodeStatus {
  state: "nouveau" | "connexion" | "connecte" | "ferme";
  appId: string;
  targetPeer: string;
  sessionId?: string;
  authenticated?: boolean;
  bytesExchanged?: number;
  provider?: string;
}

export interface PpSendResponse {
  ok: boolean;
  data?: unknown;
  errorCode?: string;
  errorMessage?: string;
  /** HITL niveau ÉLEVÉ : exécution suspendue en attente de confirmation. */
  confirmationRequired?: boolean;
}

export class PPNode {
  private readonly transport: TransportAdapter;
  private tunnel: PpTunnel | null = null;
  private state: PPNodeStatus["state"] = "nouveau";
  private readonly staticKeyPair: { publicKey: Buffer; privateKey: import("node:crypto").KeyObject };
  private hardwareSigner?: (data: Uint8Array) => Promise<Buffer>;
  private providerName?: string;
  private identity?: { peerId: string; publicKeyHex: string; hardwareAlgo: HardwareAlgorithm };

  constructor(private readonly options: PPNodeOptions) {
    // Le transport QUIC est fourni par le runtime (node:quic) — tant qu'il
    // est absent, WebSocketTransport est le chemin réel recommandé.
    this.transport = new WebSocketTransport();
    this.staticKeyPair = options.staticKeyPair ?? x25519Generate();
  }

  get status(): PPNodeStatus {
    return {
      state: this.state === "connecte" && (this.tunnel?.closed ?? false) ? "ferme" : this.state,
      appId: this.options.appId,
      targetPeer: this.options.targetPeer,
      sessionId: this.tunnel?.sessionId,
      authenticated: this.tunnel?.authenticated,
      bytesExchanged: this.tunnel?.bytesExchanged,
      provider: this.providerName,
    };
  }

  /** Clé statique de transport PUBLIQUE (donnée d'enrôlement). */
  get transportStaticPub(): string {
    return this.staticKeyPair.publicKey.toString("hex");
  }

  get peerId(): string | undefined {
    return this.identity?.peerId;
  }

  /**
   * 1) identité matérielle (fail-closed) ;
   * 2) signalisation : coordonnées du pair cible (requête signée) ;
   * 3) tunnel Noise XX + défi matériel + vérification anti-MITM ;
   * 4) prêt : node.send(command, params).
   */
  async connect(): Promise<PPNodeStatus> {
    if (this.state === "connecte") return this.status;
    this.state = "connexion";
    try {
      await this.resolveIdentity();
      const address = this.options.targetAddress ?? (await this.resolveTargetAddress());
      const conn = await this.transport.dial({ addr: address, timeoutMs: 15_000 });
      this.tunnel = await openPpTunnel(conn, {
        staticKeyPair: this.staticKeyPair,
        expectedRemoteStatic: this.expectedServerStatic ?? "",
        hardwareSign: (data) => this.requireSigner()(data),
        rekeyIntervalMs: this.options.rekeyIntervalMs,
        onEvent: (event) => {
          if (this.options.debug) console.debug("[PPNode]", JSON.stringify(event));
        },
      });
      await this.tunnel.waitForReady();
      this.state = "connecte";
      return this.status;
    } catch (error) {
      this.state = "ferme";
      throw error;
    }
  }

  /** Communication fluide bidirectionnelle (remplace les appels API). */
  async send(command: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<PpSendResponse> {
    if (!this.tunnel) throw new Error("PPNode : connect() requis avant send()");
    const payload = params ? new Uint8Array(Buffer.from(JSON.stringify(params))) : undefined;
    const response = await this.tunnel.request(command, payload, timeoutMs);
    return {
      ok: response.kind === "RESPONSE",
      data: response.payload && response.payload.length > 0 ? JSON.parse(Buffer.from(response.payload).toString("utf8")) : undefined,
      errorCode: response.errorCode,
      errorMessage: response.errorMessage,
      confirmationRequired: response.confirmationRequired,
    };
  }

  close(): void {
    this.tunnel?.close("fermeture par le client");
    this.tunnel = null;
    this.state = "ferme";
  }

  // ── Identité ──────────────────────────────────────────────────────────────

  private requireSigner(): (data: Uint8Array) => Promise<Buffer> {
    if (!this.hardwareSigner) throw new Error("PPNode : signataire matériel non résolu");
    return this.hardwareSigner;
  }

  /** Résout l'identité matérielle et retourne PeerID + algorithme. */
  async resolveIdentity(): Promise<{ peerId: string; publicKeyHex: string; hardwareAlgo: HardwareAlgorithm }> {
    if (this.identity) return this.identity;
    if (this.options.hardwareIdentity) {
      this.identity = this.options.hardwareIdentity;
      this.hardwareSigner = this.options.hardwareSign;
      if (!this.hardwareSigner) throw new Error("PPNode : hardwareIdentity fournie sans hardwareSign (clé non extractable : signature obligatoire)");
      return this.identity;
    }
    const resolution = await resolveIdentityProvider({
      hardwareBinding: this.options.hardwareBinding ?? false,
      allowSealedFallback: this.options.allowSealedFallback,
      sealSecret: this.options.sealSecret,
      sealStoragePath: this.options.sealStoragePath,
    });
    const handle = await resolution.provider.getOrCreate();
    this.providerName = resolution.provider.name;
    this.hardwareSigner = (data) => handle.sign(data);
    this.identity = { peerId: peerIdFromPublicKey(handle.publicKey), publicKeyHex: handle.publicKey.toString("hex"), hardwareAlgo: "ed25519" };
    return this.identity;
  }

  /** Signature d'un message de signalisation (anti-reconnaissance). */
  async signSignalMessage(message: string): Promise<string> {
    const signature = await this.requireSigner()(Buffer.from(message, "utf8"));
    return signature.toString("hex");
  }

  /** Charge utile d'enrôlement (POST /api/pp/enroll) — données publiques. */
  async enrollPayload(invitationToken: string): Promise<{ appId: string; peerId: string; hardwarePubKey: string; hardwareAlgo: HardwareAlgorithm; transportStaticPub: string; invitationToken: string }> {
    const identity = await this.resolveIdentity();
    return {
      appId: this.options.appId,
      peerId: identity.peerId,
      hardwarePubKey: identity.publicKeyHex,
      hardwareAlgo: identity.hardwareAlgo,
      transportStaticPub: this.transportStaticPub,
      invitationToken,
    };
  }

  /** Injectée par la signalisation : clé statique attendue du serveur (anti-MITM). */
  setExpectedServerStatic(hexStatic: string): void {
    this.expectedServerStatic = hexStatic;
  }

  private expectedServerStatic?: string;

  // ── Signalisation ─────────────────────────────────────────────────────────

  private async resolveTargetAddress(): Promise<string> {
    const signalUrl = this.options.signalingUrl;
    if (!signalUrl) throw new Error("PPNode : signalingUrl ou targetAddress requis pour joindre le pair cible");
    const identity = await this.resolveIdentity();
    const message = `resolve:${this.options.targetPeer}:${Date.now()}`;
    const signature = await this.signSignalMessage(message);
    const response = await fetch(`${signalUrl.replace(/\/$/, "")}?peer=${encodeURIComponent(this.options.targetPeer)}`, {
      headers: { "x-pp-peer": identity.peerId, "x-pp-message": message, "x-pp-signature": signature },
    });
    if (!response.ok) {
      throw new Error(`PPNode : signalisation a refusé la résolution de ${this.options.targetPeer.slice(0, 12)}… (HTTP ${response.status})`);
    }
    const body = (await response.json()) as { addresses?: Array<{ addr: string; seenAt: string }>; transportStaticPub?: string };
    const addr = body.addresses?.[0]?.addr;
    if (!addr) throw new Error("PPNode : aucune adresse disponible pour le pair cible");
    if (body.transportStaticPub) this.setExpectedServerStatic(body.transportStaticPub);
    return addr;
  }
}

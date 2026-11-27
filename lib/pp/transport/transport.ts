/**
 * PP TRANSPORT — interfaces communes (Phase 4 du plan PP).
 *
 * · WebSocketTransport : réel et testé (loopback + production derrière proxy).
 * · QuicTransport : multi-flux QUIC — adaptateur réel mais dépend du module
 *   node:quic (expérimental, absent du build Node actuel : erreur explicite,
 *   jamais de tunnel simulé).
 * · WebRtcTransport : navigateur (nœuds accélérateurs Gen3) — DataChannels,
 *   configuration STUN/TURN (Coturn) documentée dans docs/architecture/.
 *
 * Le tunnel PP (lib/pp/tunnel) est indépendant du transport choisi.
 */

export interface FrameConn {
  readonly name: string;
  /** Description distante (addr:port) pour le registre — donnée publique. */
  readonly remoteDescription: string;
  send(frame: Uint8Array): void;
  onData(callback: (frame: Uint8Array) => void): void;
  onClose(callback: (reason: string) => void): void;
  close(reason?: string): void;
  readonly closed: boolean;
}

export interface TransportServer {
  readonly boundPort: number;
  onConnection(callback: (conn: FrameConn) => void): void;
  close(): Promise<void>;
}

export interface TransportAdapter {
  readonly name: "websocket" | "quic" | "webrtc";
  createServer(options: { port: number; host?: string }): Promise<TransportServer>;
  dial(options: { addr: string; timeoutMs?: number }): Promise<FrameConn>;
}

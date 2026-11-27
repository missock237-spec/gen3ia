/**
 * PP TRANSPORT — WebSocket réel (package `ws` déjà présent).
 *
 * Serveur : node:http + WebSocketServer — traversée des pare-feux via le
 * port standard ; derrière Hyperlift/cPanel, wss:// se termine sur le
 * proxy TLS puis renvoie vers ce serveur PP. Les frames transportées sont
 * les ciphertexts Noise (le transport ne voit AUCUNE donnée en clair).
 */

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

import { FrameAssembler, frameEncode, PP_FRAME_MAX_BYTES } from "@/lib/pp/protocol/codec";
import type { FrameConn, TransportAdapter, TransportServer } from "./transport";

class WsFrameConn implements FrameConn {
  readonly name = "websocket";
  closed = false;
  private dataCallbacks: Array<(frame: Uint8Array) => void> = [];
  private closeCallbacks: Array<(reason: string) => void> = [];
  private assembler = new FrameAssembler();

  constructor(private readonly socket: WebSocket, readonly remoteDescription: string) {
    socket.on("message", (raw) => {
      const bytes = new Uint8Array(raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer));
      for (const frame of this.assembler.push(bytes)) {
        for (const callback of this.dataCallbacks) callback(frame);
      }
    });
    socket.on("close", () => this.finish("socket fermé par le pair"));
    socket.on("error", (error) => this.finish(`erreur socket : ${error.message}`));
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const callback of this.closeCallbacks) callback(reason);
  }

  send(frame: Uint8Array): void {
    if (this.closed) throw new Error("PP transport : envoi après fermeture");
    const framed = frameEncode(frame);
    if (framed.length > PP_FRAME_MAX_BYTES + 4) throw new Error("PP transport : frame hors budget");
    this.socket.send(framed);
  }

  onData(callback: (frame: Uint8Array) => void): void {
    this.dataCallbacks.push(callback);
  }

  onClose(callback: (reason: string) => void): void {
    this.closeCallbacks.push(callback);
  }

  close(reason = "fermeture locale"): void {
    if (this.closed) return;
    try {
      this.socket.close(1000, reason.slice(0, 100));
    } catch {
      /* socket déjà morte */
    }
    this.finish(reason);
  }
}

export class WebSocketTransport implements TransportAdapter {
  readonly name = "websocket" as const;
  private server?: http.Server;
  private wss?: WebSocketServer;
  private boundPort = 0;

  async createServer(options: { port: number; host?: string }): Promise<TransportServer> {
    this.server = http.createServer((_request, response) => {
      // L'upgrade WS est traité par WebSocketServer ; le HTTP plain ne révèle
      // RIEN sur les services PP (anti-reconnaissance, plan §3).
      response.writeHead(404, { "content-type": "text/plain" }).end();
      response.end();
    });
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", (socket, request) => {
      this.connectionCallbacks.forEach((callback) => callback(new WsFrameConn(socket, request.socket.remoteAddress ?? "inconnu")));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(options.port, options.host ?? "0.0.0.0", () => resolve());
    });
    this.boundPort = (this.server.address() as { port: number }).port;
    return {
      boundPort: this.boundPort,
      onConnection: (callback) => this.connectionCallbacks.push(callback),
      close: async () => {
        await new Promise<void>((resolve) => {
          this.wss?.close(() => resolve());
          this.server?.close();
        });
      },
    };
  }

  private connectionCallbacks: Array<(conn: FrameConn) => void> = [];

  async dial(options: { addr: string; timeoutMs?: number }): Promise<FrameConn> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const socket = new WebSocket(options.addr);
    const conn = new WsFrameConn(socket, options.addr);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error(`PP transport : connexion WebSocket expirée (${timeoutMs} ms) — ${options.addr}`));
      }, timeoutMs);
      socket.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`PP transport : échec connexion ${options.addr} — ${error.message}`));
      });
    });
    return conn;
  }
}

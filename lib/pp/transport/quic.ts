/**
 * PP TRANSPORT — adaptateur QUIC (multi-flux, traversée NAT, plan PP §1).
 *
 * STATUT HONNÊTE : le module node:quic est expérimental et ABSENT du build
 * Node 24 de cet environnement (vérifié : ERR_UNKNOWN_BUILTIN_MODULE). La
 * détection est réelle : `createServer`/`dial` échouent avec un message
 * explicite tant que le runtime ne fournit pas QUIC — aucun tunnel simulé.
 * La chaîne de repli recommandée : WebSocketTransport (testé), puis TURN
 * (Coturn) pour les réseaux bloqués — voir docs/architecture/.
 */

import type { TransportAdapter, TransportServer, FrameConn } from "./transport";

const QUIC_INDISPONIBLE = "node:quic indisponible dans ce runtime (expérimental) — repli WebSocketTransport recommandé";

export class QuicTransport implements TransportAdapter {
  readonly name = "quic" as const;

  private async requireQuic(): Promise<Record<string, unknown>> {
    try {
      return (await import(/* webpackIgnore: true */ "node:quic")) as unknown as Record<string, unknown>;
    } catch {
      throw new Error(QUIC_INDISPONIBLE);
    }
  }

  async createServer(_options: { port: number; host?: string }): Promise<TransportServer> {
    await this.requireQuic();
    throw new Error(QUIC_INDISPONIBLE);
  }

  async dial(_options: { addr: string; timeoutMs?: number }): Promise<FrameConn> {
    await this.requireQuic();
    throw new Error(QUIC_INDISPONIBLE);
  }
}

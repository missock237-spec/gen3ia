/**
 * API PP — résolution de signalisation (Phase 1).
 *
 * GET /api/pp/signal?peer=<peerId> — renvoie les coordonnées réseau
 * TEMPORAIRES du pair cible ET sa clé statique publique (anti-MITM côté
 * client). Authentification : en-têtes x-pp-peer / x-pp-message /
 * x-pp-signature — la requête doit être SIGNÉE par la clé matérielle d'un
 * pair ACTIF et fraîche (fenêtre 30 s). Un pair en attente, révoqué ou
 * inconnu n'obtient RIEN (anti-reconnaissance, plan §3).
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { resolvePeerAddresses, SIGNAL_TIMESTAMP_WINDOW_MS } from "@/lib/pp/signaling/service";
import { getTrustRegistry } from "@/lib/pp/server/signaling-store";

const QuerySchema = z.object({ peer: z.string().regex(/^[0-9a-f]{64}$/) });

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({ peer: url.searchParams.get("peer") ?? "" });
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "requete-invalide", message: "paramètre peer (peerId hex 64) requis" } }, { status: 400 });
  }
  const requesterPeerId = request.headers.get("x-pp-peer") ?? "";
  const message = request.headers.get("x-pp-message") ?? "";
  const signature = request.headers.get("x-pp-signature") ?? "";
  if (!/^[0-9a-f]{64}$/.test(requesterPeerId) || !signature) {
    return NextResponse.json({ error: { code: "non-authentifie", message: "en-têtes x-pp-peer/x-pp-message/x-pp-signature requis" } }, { status: 401 });
  }

  // Fenêtre d'horodatage : la requête doit porter un horodatage frais.
  const parts = message.split(":");
  const timestamp = Number(parts[2]);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > SIGNAL_TIMESTAMP_WINDOW_MS) {
    return NextResponse.json({ error: { code: "horodatage-expire", message: "requête de signalisation périmée (anti-replay)" } }, { status: 401 });
  }
  if (parts[0] !== "resolve" || parts[1] !== parsed.data.peer) {
    return NextResponse.json({ error: { code: "requete-invalide", message: "message signé ≠ requête (anti-tampering)" } }, { status: 400 });
  }

  const registry = getTrustRegistry();
  await registry.init();
  try {
    const result = await resolvePeerAddresses(registry, requesterPeerId, parsed.data.peer, message, signature);
    const transportStaticPub = registry.require(parsed.data.peer).transportStaticPub;
    return NextResponse.json({ ...result, transportStaticPub, addresses: result.addresses.length > 0 ? result.addresses : [{ addr: `ws://localhost:${process.env.PP_SYSTEM_NODE_PORT ?? 7601}`, seenAt: new Date().toISOString() }] });
  } catch (error) {
    return NextResponse.json({ error: { code: "acces-refuse", message: error instanceof Error ? error.message : String(error) } }, { status: 403 });
  }
}

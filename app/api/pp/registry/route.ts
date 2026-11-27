/**
 * API PP — tableau de bord d'administration du registre (Phase 1).
 *
 * GET  /api/pp/registry — liste des pairs + jetons (ADMIN uniquement).
 * POST /api/pp/registry — approve / revoke / create_invitation (ADMIN).
 *
 * La révocation est INSTANTANÉE : le nœud système re-consulte le registre à
 * chaque requête métier — les tunnels vivants sont coupés sans toucher au
 * code source des clients (plan §3).
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/security/admin-access";
import { getTrustRegistry } from "@/lib/pp/server/signaling-store";

const AdminActionSchema = z.union([
  z.object({ action: z.literal("approve"), peerId: z.string().regex(/^[0-9a-f]{64}$/), label: z.string().max(128).optional() }),
  z.object({ action: z.literal("revoke"), peerId: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.object({ action: z.literal("create_invitation"), ttlHours: z.number().int().min(1).max(720).optional(), label: z.string().max(128).optional() }),
]);

export async function GET(request: Request) {
  await requireAdmin(request as never);
  const registry = getTrustRegistry();
  await registry.init();
  return NextResponse.json({
    peers: registry.list().map((peer) => ({ ...peer, hardwarePubKey: peer.hardwarePubKey.slice(0, 16) + "…" })),
    tokens: registry.listTokens().map((token) => ({ ...token, token: token.usedAt ? "(consommé)" : token.token })),
  });
}

export async function POST(request: Request) {
  await requireAdmin(request as never);
  const registry = getTrustRegistry();
  await registry.init();
  const body = await request.json().catch(() => null);
  const parsed = AdminActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "requete-invalide", message: parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") } }, { status: 400 });
  }
  try {
    if (parsed.data.action === "approve") {
      const record = registry.approve(parsed.data.peerId, parsed.data.label);
      return NextResponse.json({ status: record.status, peerId: record.peerId, approvedAt: record.approvedAt });
    }
    if (parsed.data.action === "revoke") {
      const record = registry.revoke(parsed.data.peerId);
      return NextResponse.json({ status: record.status, peerId: record.peerId, revokedAt: record.revokedAt, message: "tunnels vivants coupés à chaud" });
    }
    const token = registry.createInvitation({ ttlHours: parsed.data.ttlHours, label: parsed.data.label });
    return NextResponse.json({ token: token.token, expiresAt: token.expiresAt }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: { code: "action-refusee", message: error instanceof Error ? error.message : String(error) } }, { status: 409 });
  }
}

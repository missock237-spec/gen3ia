import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { deleteNetwork, getNetwork, updateNetwork } from "@/lib/agents/networks/repository";

/**
 * Réseau d'agents (concepts post-SaaS #3/#8) — ressource individuelle.
 * GET    : détail (propriétaire-scopé, 404 anti-énumération).
 * PATCH  : mise à jour (nom, description, topologie, membres, coordinateur, statut).
 * DELETE : suppression réelle du lien d'équipe (les agents restent au Studio).
 */
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const network = await getNetwork(user.uid, id);
    if (!network) return NextResponse.json({ error: "Réseau introuvable" }, { status: 404 });
    return NextResponse.json({ network });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Réseau indisponible" },
      { status: errorStatus(error, 500) },
    );
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const body = await request.json();
    const network = await updateNetwork(user.uid, id, body);
    return NextResponse.json({ network });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mise à jour impossible";
    const status = message.includes("introuvable") ? 404 : message.includes("Organisation") ? 403 : 400;
    return NextResponse.json({ error: message }, { status: errorStatus(error, status) });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    await deleteNetwork(user.uid, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Suppression impossible";
    const status = message.includes("introuvable") ? 404 : 400;
    return NextResponse.json({ error: message }, { status: errorStatus(error, status) });
  }
}

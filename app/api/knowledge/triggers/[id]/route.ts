import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { deleteKnowledgeTrigger, updateKnowledgeTrigger } from "@/lib/knowledge/triggers";

/** Déclencheur d'ingestion — ressource individuelle (PATCH/DELETE). */
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const body = (await request.json()) as { enabled?: unknown; name?: unknown };
    const trigger = await updateKnowledgeTrigger(user.uid, id, {
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(typeof body.name === "string" ? { name: body.name } : {}),
    });
    return NextResponse.json({ trigger });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mise à jour impossible";
    return NextResponse.json({ error: message }, { status: errorStatus(error, message.includes("introuvable") ? 404 : 400) });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    await deleteKnowledgeTrigger(user.uid, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Suppression impossible";
    return NextResponse.json({ error: message }, { status: errorStatus(error, message.includes("introuvable") ? 404 : 400) });
  }
}

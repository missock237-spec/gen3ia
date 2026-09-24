import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { adminDb } from "@/lib/firebase/admin";
import { WorkflowSchema } from "@/lib/workflows/types";
import { validateWorkflow } from "@/lib/workflows/validator";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

/**
 *  GET    /api/workflows/[id]  → détail du workflow ;
 *  PATCH  /api/workflows/[id]  → mise à jour (bump de version automatique) ;
 *  DELETE /api/workflows/[id]  → suppression.
 */

async function loadOwned(userId: string, id: string): Promise<(Record<string, unknown> & { userId: string }) | null> {
  const doc = await adminDb.collection("workflows").doc(id).get();
  if (!doc.exists) return null;
  const data = doc.data() as Record<string, unknown> & { userId?: string };
  if (data.userId !== userId) return null;
  return { ...data, userId: userId };
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const workflow = await loadOwned(user.uid, id);
    if (!workflow) return NextResponse.json({ error: "Workflow introuvable." }, { status: 404 });
    return NextResponse.json({ workflow });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Workflow indisponible"), { status: errorStatus(error, 500) });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const existing = await loadOwned(user.uid, id);
    if (!existing) return NextResponse.json({ error: "Workflow introuvable.", requestId }, { status: 404 });

    const body = (await request.json()) as Record<string, unknown>;
    const nextVersion = Number(existing.version ?? 1) + 1;
    const parsed = WorkflowSchema.safeParse({ ...existing, ...body, id, version: nextVersion });
    if (!parsed.success) {
      return NextResponse.json({ error: "Structure de workflow invalide.", issues: parsed.error.flatten(), requestId }, { status: 422 });
    }
    const validation = validateWorkflow(parsed.data);
    if (!validation.valid) {
      return NextResponse.json({ error: `Workflow invalide : ${validation.errors.join(" | ")}`, requestId }, { status: 422 });
    }

    await adminDb.collection("workflows").doc(id).set({
      ...parsed.data,
      userId: user.uid,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    return NextResponse.json({ ok: true, version: nextVersion, requestId });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Mise à jour impossible"), { status: errorStatus(error, 500) });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const existing = await loadOwned(user.uid, id);
    if (!existing) return NextResponse.json({ error: "Workflow introuvable." }, { status: 404 });
    await adminDb.collection("workflows").doc(id).delete();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible"), { status: errorStatus(error, 500) });
  }
}

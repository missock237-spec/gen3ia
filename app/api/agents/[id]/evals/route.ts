import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import {
  createTestSet,
  deleteTestSet,
  listTestRuns,
  listTestSets,
  TestSetSchema,
} from "@/lib/agents/evals";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Evals d'un agent :
 *  GET    /api/agents/[id]/evals   → test sets + derniers runs ;
 *  POST   /api/agents/[id]/evals   → création d'un test set ;
 *  DELETE /api/agents/[id]/evals?setId=… → suppression d'un test set.
 */

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const sets = await listTestSets(user.uid, id);
    const runs = await Promise.all(sets.slice(0, 5).map(async (set) => ({ setId: set.id, runs: await listTestRuns(user.uid, set.id, 5) })));
    return NextResponse.json({ sets, runs: Object.fromEntries(runs.map((entry) => [entry.setId, entry.runs])) });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Liste des évaluations indisponible"), { status: errorStatus(error, 500) });
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const parsed = TestSetSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Test set invalide : au moins un cas avec une demande (2–2000 car.).", requestId }, { status: 422 });
    }
    const created = await createTestSet(user.uid, id, parsed.data);
    return NextResponse.json({ setId: created.id, requestId }, { status: 201 });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Création du test set impossible"), { status: errorStatus(error, 500) });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const setId = request.nextUrl.searchParams.get("setId")?.trim();
    if (!setId) return NextResponse.json({ error: "setId manquant." }, { status: 422 });
    // deleteTestSet vérifie déjà la propriété (userId) du test set.
    const deleted = await deleteTestSet(user.uid, setId);
    if (!deleted) return NextResponse.json({ error: "Test set introuvable." }, { status: 404 });
    void id;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible"), { status: errorStatus(error, 500) });
  }
}

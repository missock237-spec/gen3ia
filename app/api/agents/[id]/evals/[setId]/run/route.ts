import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { runTestSet } from "@/lib/agents/evals";

export const runtime = "nodejs";
export const maxDuration = 300;

type RouteContext = { params: Promise<{ id: string }> };

const BODY_SCHEMA = z.object({ setId: z.string().trim().min(1) });

/** POST /api/agents/[id]/evals/[setId]/run — exécute tous les cas (facturé). */
export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const body = BODY_SCHEMA.parse(await request.json().catch(() => ({})));
    const summary = await runTestSet(user.uid, id, body.setId);
    return NextResponse.json({ summary, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "setId requis.", requestId }, { status: 422 });
    }
    const message = error instanceof Error ? error.message : "Exécution de l'évaluation impossible.";
    const status = /insufficient|budget/i.test(message) ? 402 : errorStatus(error, 500);
    return NextResponse.json({ error: message, requestId }, { status });
  }
}

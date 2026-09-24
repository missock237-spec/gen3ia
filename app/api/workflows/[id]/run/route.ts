import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import z from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { adminDb } from "@/lib/firebase/admin";
import { runWorkflowGraph } from "@/lib/workflows/executor";
import type { Workflow } from "@/lib/workflows/types";

export const runtime = "nodejs";
export const maxDuration = 300;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/workflows/[id]/run
 *  - exécution : {input?} → démarre le graphe (peut se terminer en
 *    awaiting_approval si le graphe contient un nœud approval) ;
 *  - reprise   : {runId, approve:true} → valide le point humain et continue.
 */

const BODY_SCHEMA = z.object({
  input: z.record(z.string(), z.unknown()).optional(),
  runId: z.string().trim().min(1).optional(),
  approve: z.boolean().optional(),
});

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const doc = await adminDb.collection("workflows").doc(id).get();
    if (!doc.exists || (doc.data() as { userId?: string } | undefined)?.userId !== user.uid) {
      return NextResponse.json({ error: "Workflow introuvable.", requestId }, { status: 404 });
    }
    const workflow = doc.data() as unknown as Workflow;

    const body = BODY_SCHEMA.parse(await request.json().catch(() => ({})));
    const state = await runWorkflowGraph({
      userId: user.uid,
      workflow,
      ...(body.runId ? { runId: body.runId } : {}),
      ...(body.input ? { input: body.input } : {}),
      resumeApproved: body.approve === true,
    });
    return NextResponse.json({ run: state, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Corps de requête invalide.", requestId }, { status: 422 });
    }
    const message = error instanceof Error ? error.message : "Exécution impossible.";
    const status = /insufficient/i.test(message) ? 402 : errorStatus(error, 500);
    return NextResponse.json({ error: message, requestId }, { status });
  }
}

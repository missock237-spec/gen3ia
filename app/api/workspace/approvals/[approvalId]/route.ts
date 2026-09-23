import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { decideApproval, getApproval } from "@/lib/domain/approvals/repository";
import { getRun } from "@/lib/domain/runs/repository";
import {
  appendMessage,
  getConversation,
} from "@/lib/chat/repository";
import {
  executeApprovedStep,
  rejectApprovalStep,
} from "@/lib/domain/conversations/engine";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ approvalId: string }> };

const DecisionSchema = z.object({ decision: z.enum(["approved", "rejected"]) });

/**
 * Décision humaine sur une action sensible (contrôle humain inline) :
 *  - approved : l'étape du run s'exécute réellement, l'assistant confirme ;
 *  - rejected : l'étape est ignorée, aucune donnée n'est envoyée.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireUser(request);
    const { approvalId } = await params;
    const { decision } = DecisionSchema.parse(await request.json());

    const existing = await getApproval(user.uid, approvalId);
    if (!existing) return NextResponse.json({ error: "Validation introuvable." }, { status: 404 });

    const { approval, alreadyDecided } = await decideApproval(user.uid, approvalId, decision);
    const conversation = await getConversation(user.uid, approval.conversationId);
    if (!conversation) return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });

    if (alreadyDecided) {
      return NextResponse.json({ approval, alreadyDecided: true });
    }

    const run = await getRun(user.uid, approval.runId);
    if (!run) return NextResponse.json({ error: "Run introuvable." }, { status: 404 });

    if (decision === "approved") {
      const outcome = await executeApprovedStep({
        userId: user.uid,
        conversationId: approval.conversationId,
        run,
        approval,
      });
      const message = await appendMessage({
        conversationId: approval.conversationId,
        userId: user.uid,
        role: "assistant",
        content: `✓ Action approuvée et exécutée.\n\n${outcome.summary}`,
        runId: run.id,
        generationStatus: "complete",
      });
      return NextResponse.json({ approval, run, artifact: outcome.artifact ?? null, message });
    }

    await rejectApprovalStep({ userId: user.uid, run, approval });
    const message = await appendMessage({
      conversationId: approval.conversationId,
      userId: user.uid,
      role: "assistant",
      content: `Action rejetée : « ${approval.title} ». Aucune donnée n'a été transmise.`,
      runId: run.id,
      generationStatus: "complete",
    });
    return NextResponse.json({ approval, run, message });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Décision impossible."), { status: errorStatus(error, 400) });
  }
}

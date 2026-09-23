import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import {
  deleteConversation,
  getConversation,
  listMessages,
  renameConversation,
  updateConversation,
} from "@/lib/chat/repository";
import { listApprovalsForConversation } from "@/lib/domain/approvals/repository";
import { listArtifacts } from "@/lib/domain/artifacts/repository";
import { listRunsForConversation } from "@/lib/domain/runs/repository";
import { getProject } from "@/lib/domain/projects/repository";

type RouteContext = { params: Promise<{ conversationId: string }> };

const PatchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  projectId: z.string().trim().max(128).nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

/** Détail complet d'une conversation : messages, timeline, artefacts, validations. */
export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireUser(request);
    const { conversationId } = await params;
    const conversation = await getConversation(user.uid, conversationId);
    if (!conversation) return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });

    const [messages, runs, artifacts, approvals] = await Promise.all([
      listMessages(user.uid, conversationId, 200),
      listRunsForConversation(user.uid, conversationId, 20),
      listArtifacts(user.uid, { conversationId, limit: 100 }),
      listApprovalsForConversation(user.uid, conversationId, 50),
    ]);

    const project = conversation.projectId ? await getProject(user.uid, conversation.projectId) : null;

    return NextResponse.json({ conversation, project, messages, runs, artifacts, approvals });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Impossible de charger la conversation."), { status: errorStatus(error, 500) });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireUser(request);
    const { conversationId } = await params;
    const body = PatchSchema.parse(await request.json().catch(() => ({})));
    if (body.projectId) {
      const project = await getProject(user.uid, body.projectId);
      if (!project) return NextResponse.json({ error: "Projet introuvable." }, { status: 404 });
    }
    if (body.title) await renameConversation(user.uid, conversationId, body.title);
    const conversation = await updateConversation(user.uid, conversationId, {
      projectId: body.projectId ?? undefined,
      status: body.status,
    });
    if (!conversation) return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
    return NextResponse.json({ conversation });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Mise à jour impossible."), { status: errorStatus(error, 400) });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireUser(request);
    const { conversationId } = await params;
    await deleteConversation(user.uid, conversationId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible."), { status: errorStatus(error, 404) });
  }
}

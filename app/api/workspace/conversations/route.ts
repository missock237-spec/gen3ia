import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { createConversation, listConversations } from "@/lib/chat/repository";
import { getProject } from "@/lib/domain/projects/repository";

const CreateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  projectId: z.string().trim().min(1).max(128).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const params = new URL(request.url).searchParams;
    const limitRaw = Number(params.get("limit") ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 50;
    const projectId = params.get("projectId") ?? undefined;
    const query = params.get("q") ?? undefined;
    if (projectId) {
      const project = await getProject(user.uid, projectId);
      if (!project) return NextResponse.json({ error: "Projet introuvable." }, { status: 404 });
    }
    const conversations = await listConversations(user.uid, limit, { projectId, query });
    return NextResponse.json({ conversations });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Impossible de charger les conversations."), { status: errorStatus(error, 500) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const body = CreateSchema.parse(await request.json().catch(() => ({})));
    if (body.projectId) {
      const project = await getProject(user.uid, body.projectId);
      if (!project) return NextResponse.json({ error: "Projet introuvable." }, { status: 404 });
    }
    const conversation = await createConversation(user.uid, body.title ?? "Nouvelle conversation", {
      projectId: body.projectId,
    });
    return NextResponse.json({ conversation }, { status: 201 });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Création impossible."), { status: errorStatus(error, 400) });
  }
}

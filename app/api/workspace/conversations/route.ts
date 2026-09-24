import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
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

    // Audit 25-c : la création de conversations n'était pas limitée
    // (créations illimitées = risque d'abus Firestore + spam). Même
    // pattern que messages/stream : limiter RENFORCÉ (local + Redis
    // distribué), 20 créations/minute/utilisateur, 429 avec Retry-After.
    const limit = await enforceRateLimit(`ws-conv-create:${user.uid}`, {
      limit: 20,
      windowMs: 60_000,
    });
    if (!limit.allowed) {
      return Response.json(
        { error: "Trop de conversations créées. Réessayez dans un instant." },
        { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))) } },
      );
    }

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

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { rateLimit } from "@/lib/security/rate-limit";
import { editVideoScenes } from "@/lib/video/planner";
import { deleteProject, getProject, updateProject, VideoProjectPatchSchema } from "@/lib/video/store";

/**
 * Projet vidéo individuel : lecture (GET), édition (PATCH — scènes en
 * direct OU instruction conversationnelle traitée par le monteur IA) et
 * suppression (DELETE).
 */

interface RouteContext { params: Promise<{ id: string }> }

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const project = await getProject(user.uid, id);
    if (!project) return NextResponse.json({ error: "Projet vidéo introuvable." }, { status: 404 });
    return NextResponse.json({ project }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Projet indisponible" },
      { status: 401 },
    );
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const limit = rateLimit(`video-edit:${user.uid}`, { limit: 40, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Limite d'éditions atteinte pour cette heure.", requestId }, { status: 429 });
    }

    const { id } = await context.params;
    const project = await getProject(user.uid, id);
    if (!project) return NextResponse.json({ error: "Projet vidéo introuvable.", requestId }, { status: 404 });

    const body = VideoProjectPatchSchema.parse(await request.json());

    if (body.instruction) {
      // Édition conversationnelle : le monteur IA applique l'instruction.
      const edited = await editVideoScenes({
        instruction: body.instruction,
        title: project.title,
        format: project.format,
        scenes: project.scenes,
      });
      const updated = await updateProject(user.uid, id, {
        title: edited.title,
        scenes: edited.scenes,
        ...(body.status ? { status: body.status } : {}),
      });
      return NextResponse.json({ project: updated, appliedInstruction: true, requestId });
    }

    const updated = await updateProject(user.uid, id, {
      ...(body.scenes ? { scenes: body.scenes } : {}),
      ...(body.title ? { title: body.title } : {}),
      ...(body.status ? { status: body.status } : {}),
    });
    return NextResponse.json({ project: updated, requestId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Édition invalide (scènes ou instruction)." }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Édition impossible.";
    return NextResponse.json({ error: message, requestId }, { status: 502 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    await deleteProject(user.uid, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Suppression impossible.";
    const status = message.includes("introuvable") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

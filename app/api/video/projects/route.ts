import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { rateLimit } from "@/lib/security/rate-limit";
import { planVideoScenes } from "@/lib/video/planner";
import {
  VideoProjectCreateSchema,
  countProjects,
  createProject,
  listProjects,
  MAX_PROJECTS_PER_USER,
} from "@/lib/video/store";
import { VIDEO_FORMATS } from "@/lib/video/types";

/**
 * Projets vidéo du Studio : liste (GET) et création (POST). La création
 * lance le planificateur de storyboard (LLM) — le projet est renvoyé avec
 * ses scènes prêtes à éditer.
 */

export const runtime = "nodejs";

const CreateBody = VideoProjectCreateSchema.extend({
  format: z.enum(VIDEO_FORMATS).default("16:9"),
});

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const projects = await listProjects(user.uid);
    return NextResponse.json({ projects }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Projets vidéo indisponibles" },
      { status: 401 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = rateLimit(`video-create:${user.uid}`, { limit: 10, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Limite de créations vidéo atteinte pour cette heure." }, { status: 429 });
    }

    const body = CreateBody.parse(await request.json());
    if ((await countProjects(user.uid)) >= MAX_PROJECTS_PER_USER) {
      return NextResponse.json({ error: `Limite de ${MAX_PROJECTS_PER_USER} projets vidéo atteinte.` }, { status: 409 });
    }

    const planned = await planVideoScenes({
      brief: body.brief,
      format: body.format,
      sceneCount: body.sceneCount,
    });

    const project = await createProject(user.uid, {
      title: body.title.trim() || planned.title,
      brief: body.brief,
      format: body.format,
      scenes: planned.scenes,
      status: "planned",
    });

    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Brief vidéo invalide (titre, description, format)." }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Création du projet vidéo impossible.";
    const status = message.includes("planificateur") ? 502 : message.includes("Authorization") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

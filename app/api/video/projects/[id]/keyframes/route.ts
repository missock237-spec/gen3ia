import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { rateLimit } from "@/lib/security/rate-limit";
import { generateSceneKeyframe } from "@/lib/video/keyframes";
import { getProject, updateProject } from "@/lib/video/store";
import type { VideoScene } from "@/lib/video/types";
import { createPermanentDownloadUrl } from "@/lib/storage/permanent-user-storage";

/**
 * Image clé d'une scène : POST génère l'image IA (text-to-image), la stocke
 * dans l'espace permanent de l'utilisateur et l'associe à la scène ;
 * GET (?sceneId=) retourne une URL de téléchargement signée courte.
 */

interface RouteContext { params: Promise<{ id: string }> }

export const runtime = "nodejs";

const KeyframeBody = z.object({
  sceneId: z.string().trim().min(1).max(64),
});

function requireScene(project: { scenes: VideoScene[] }, sceneId: string): VideoScene {
  const scene = project.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error("Scène introuvable dans ce projet.");
  return scene;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const limit = rateLimit(`video-keyframe:${user.uid}`, { limit: 30, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Limite de générations d'images atteinte pour cette heure.", requestId }, { status: 429 });
    }

    const { id } = await context.params;
    const project = await getProject(user.uid, id);
    if (!project) return NextResponse.json({ error: "Projet vidéo introuvable.", requestId }, { status: 404 });

    const body = KeyframeBody.parse(await request.json());
    const scene = requireScene(project, body.sceneId);

    const keyframe = await generateSceneKeyframe({
      userId: user.uid,
      projectId: project.id,
      sceneId: scene.id,
      sceneTitle: scene.title,
      visualPrompt: scene.visualPrompt,
      format: project.format,
    });

    const scenes = project.scenes.map((item) =>
      item.id === scene.id
        ? { ...item, keyframePath: keyframe.path, keyframeFilename: keyframe.filename }
        : item,
    );
    const updated = await updateProject(user.uid, id, { scenes });
    const url = await createPermanentDownloadUrl(user.uid, keyframe.path);

    return NextResponse.json({ project: updated, keyframe: { path: keyframe.path, url, model: keyframe.model }, requestId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "sceneId requis.", requestId }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Génération de l'image clé impossible.";
    const status = message.includes("Scène introuvable") ? 404 : message.includes("Authorization") ? 401 : 502;
    return NextResponse.json({ error: message, requestId }, { status });
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const project = await getProject(user.uid, id);
    if (!project) return NextResponse.json({ error: "Projet vidéo introuvable." }, { status: 404 });

    const sceneId = new URL(request.url).searchParams.get("sceneId")?.trim() ?? "";
    const scene = project.scenes.find((item) => item.id === sceneId && item.keyframePath);
    if (!scene?.keyframePath) return NextResponse.json({ error: "Aucune image clé pour cette scène." }, { status: 404 });

    const url = await createPermanentDownloadUrl(user.uid, scene.keyframePath);
    return NextResponse.json({ url }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "URL indisponible" },
      { status: error instanceof Error && error.message.includes("Authorization") ? 401 : 500 },
    );
  }
}

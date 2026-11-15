import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { getOwnedProject, patchProject, deleteProject, setProjectStatus, listVersions } from "@/lib/video/project-service";
import { VIDEO_PROJECT_STATUSES } from "@/lib/video/types";

export const runtime = "nodejs";

const PatchSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().max(4000).optional(),
  aspectRatio: z.enum(["16:9", "9:16", "1:1", "4:5", "21:9"]).optional(),
  resolution: z.enum(["480p", "720p", "1080p", "1440p", "4K"]).optional(),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).optional(),
  targetDurationSec: z.number().int().min(10).max(3600).optional(),
  style: z.string().min(2).max(200).optional(),
  voicePreference: z.object({ kind: z.enum(["auto", "user_voice", "library"]), voiceId: z.string().max(200).optional() }).optional(),
  musicMood: z.string().max(120).optional(),
  status: z.enum(VIDEO_PROJECT_STATUSES).optional(),
});

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-project-get", rateLimit: { limit: 120, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const project = await getOwnedProject(guard.context.userId, projectId);
    if (!project) return NextResponse.json({ error: "Projet vidéo introuvable." }, { status: 404 });
    const versions = await listVersions(guard.context.userId, projectId);
    return NextResponse.json({ project, versions: versions.map((v) => ({ id: v.id, versionNumber: v.versionNumber, label: v.label, createdAt: v.createdAt, createdBy: v.createdBy, note: v.note })) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Lecture impossible" }, { status: errorStatus(error, 500) });
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-project-patch", rateLimit: { limit: 60, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const patch = PatchSchema.parse(await request.json());
    const project = await patchProject(guard.context.userId, projectId, patch);
    return NextResponse.json({ project });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Mise à jour impossible" }, { status: errorStatus(error, 400) });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-project-delete", rateLimit: { limit: 6, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const result = await deleteProject(guard.context.userId, projectId);
    return NextResponse.json({ deleted: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Suppression impossible" }, { status: errorStatus(error, 400) });
  }
}

/** Archivage explicite (libère une place de projet actif). */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-project-archive", rateLimit: { limit: 20, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const { status } = z.object({ status: z.enum(["archived", "draft"]) }).parse(await request.json());
    await setProjectStatus(guard.context.userId, projectId, status);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Archivage impossible" }, { status: errorStatus(error, 400) });
  }
}

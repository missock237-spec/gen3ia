import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { VideoProjectCreateSchema } from "@/lib/video/security";
import { createProject, listProjects, duplicateProject } from "@/lib/video/project-service";

export const runtime = "nodejs";

const DuplicateSchema = z.object({ duplicateOf: z.string().min(1).max(120) });

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { key: "video-projects-list", rateLimit: { limit: 60, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const projects = await listProjects(guard.context.userId);
    return NextResponse.json({ projects });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Liste impossible" }, { status: errorStatus(error, 500) });
  }
}

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request, { key: "video-projects-create", rateLimit: { limit: 10, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const body = await request.json();
    // Duplication : « copie du projet » avec tout son contenu éditable.
    if (typeof body === "object" && body !== null && "duplicateOf" in body) {
      const { duplicateOf } = DuplicateSchema.parse(body);
      const copy = await duplicateProject(guard.context.userId, duplicateOf);
      return NextResponse.json({ project: copy }, { status: 201 });
    }
    const input = VideoProjectCreateSchema.parse(body);
    const project = await createProject(guard.context.userId, input);
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Création impossible" }, { status: errorStatus(error, 400) });
  }
}

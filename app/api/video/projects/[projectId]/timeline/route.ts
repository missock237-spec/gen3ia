import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { getOwnedProjectOrThrow } from "@/lib/video/project-service";
import { ensureProjectTimeline } from "@/lib/video/timeline-bootstrap";
import { applyTimelinePatch, type TimelinePatchOp } from "@/lib/video/timeline-service";
import { TimelinePatchSchema } from "@/lib/video/security";

export const runtime = "nodejs";

type Params = { params: Promise<{ projectId: string }> };

/**
 * Timeline multi-pistes — initialisée paresseusement depuis le scénario.
 * Task 1-a FIX 2 : la lazy-init vit dans lib/video/timeline-bootstrap.ts
 * (SOURCE UNIQUE) — le worker de rendu matérialise la MÊME timeline au
 * stade plan, plus d'échec « Timeline absente » au rendu.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-timeline-get", rateLimit: { limit: 120, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const { project } = await ensureProjectTimeline(guard.context.userId, projectId);
    return NextResponse.json({ timeline: project.timeline });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Timeline indisponible" }, { status: errorStatus(error, 400) });
  }
}

/** Opération d'édition typée (agent conversationnel ET panneau timeline). */
export async function PATCH(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-timeline-patch", rateLimit: { limit: 90, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const { op, clipId, payload } = TimelinePatchSchema.parse(await request.json());
    await getOwnedProjectOrThrow(guard.context.userId, projectId);
    const { snapshotVersion, patchProject: patchProjectSrv } = await import("@/lib/video/project-service");
    const project = await getOwnedProjectOrThrow(guard.context.userId, projectId);
    if (!project.timeline) throw new Error("Timeline absente — ouvrez d'abord la timeline.");
    await snapshotVersion(guard.context.userId, projectId, "Édition timeline", "user");
    const timeline = applyTimelinePatch(project.timeline, op as TimelinePatchOp, clipId, payload);
    await patchProjectSrv(guard.context.userId, projectId, { timeline });
    return NextResponse.json({ timeline });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Édition impossible" }, { status: errorStatus(error, 400) });
  }
}

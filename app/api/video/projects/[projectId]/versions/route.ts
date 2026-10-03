import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { listVersions, restoreVersion } from "@/lib/video/project-service";

export const runtime = "nodejs";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-versions-list", rateLimit: { limit: 60, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const versions = await listVersions(guard.context.userId, projectId);
    return NextResponse.json({ versions });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Liste impossible" }, { status: errorStatus(error, 404) });
  }
}

/** « Reviens à la version 2 » — restauration complète de l'instantané. */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-versions-restore", rateLimit: { limit: 15, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const { versionNumber } = z.object({ versionNumber: z.number().int().min(1) }).parse(await request.json());
    const project = await restoreVersion(guard.context.userId, projectId, versionNumber);
    return NextResponse.json({ project });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Restauration impossible" }, { status: errorStatus(error, 400) });
  }
}

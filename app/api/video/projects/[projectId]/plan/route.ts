import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { DirectorBriefSchema } from "@/lib/video/security";
import { applyProductionPlan } from "@/lib/video/director-service";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ projectId: string }> };

/** Le Directeur transforme la demande libre en plan de production appliqué au projet. */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-plan", rateLimit: { limit: 12, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const { brief } = DirectorBriefSchema.parse(await request.json());
    const result = await applyProductionPlan(guard.context.userId, projectId, brief);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Planification impossible" }, { status: errorStatus(error, 500) });
  }
}

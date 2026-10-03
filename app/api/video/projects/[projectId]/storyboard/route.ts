import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { generateStoryboard } from "@/lib/video/script-service";

export const runtime = "nodejs";

type Params = { params: Promise<{ projectId: string }> };

/** Storyboard Engine : découpage horodaté scène par scène + bible visuelle. */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-storyboard", rateLimit: { limit: 12, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const storyboard = await generateStoryboard(guard.context.userId, projectId);
    return NextResponse.json({ storyboard });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Storyboard impossible" }, { status: errorStatus(error, 400) });
  }
}

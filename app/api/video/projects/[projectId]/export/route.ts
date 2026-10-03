import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { startAdditionalExports } from "@/lib/video/export-service";

export const runtime = "nodejs";

type Params = { params: Promise<{ projectId: string }> };

const ExportSchema = z.object({
  sourceJobId: z.string().min(1).max(120),
  targets: z.array(z.enum(["shorts_9_16", "tiktok_9_16", "reels_9_16", "square_1_1", "youtube_16_9", "facebook_16_9"])).min(1).max(6),
});

/** Formats de diffusion dérivés d'un rendu terminé (recadrage + sous-titres adaptés). */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-export", rateLimit: { limit: 10, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const { sourceJobId, targets } = ExportSchema.parse(await request.json());
    const origin = process.env.GEN3IA_APP_ORIGIN?.trim() || request.nextUrl.origin;
    const result = await startAdditionalExports({ userId: guard.context.userId, projectId, sourceJobId, targets, origin });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Export impossible" }, { status: errorStatus(error, 400) });
  }
}

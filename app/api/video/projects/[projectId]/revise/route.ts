import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { RevisionRequestSchema } from "@/lib/video/security";
import { applyRevision } from "@/lib/video/revision-service";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ projectId: string }> };

/**
 * Modification conversationnelle : l'utilisateur parle au Directeur
 * (« trop rapide », « mets ma voix », « version TikTok », « supprime la
 * scène 12 », « reviens à la version 2 »…) et le projet est modifié.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-revise", rateLimit: { limit: 30, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const { instruction } = RevisionRequestSchema.parse(await request.json());
    const origin = process.env.GEN3IA_APP_ORIGIN?.trim() || request.nextUrl.origin;
    const result = await applyRevision({
      userId: guard.context.userId,
      projectId,
      instruction,
      origin,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Révision impossible" }, { status: errorStatus(error, 400) });
  }
}

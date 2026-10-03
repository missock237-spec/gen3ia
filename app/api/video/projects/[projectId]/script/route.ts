import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { generateScript } from "@/lib/video/script-service";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ projectId: string }> };

/** Script Engine : scénario structuré complet (Hook → Chapitres → Scènes → CTA). */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-script", rateLimit: { limit: 12, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const result = await generateScript(guard.context.userId, projectId);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Scénario impossible" }, { status: errorStatus(error, 500) });
  }
}

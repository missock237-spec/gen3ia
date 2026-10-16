import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { generateStoryboard } from "@/lib/video/script-service";
// Task 153 — paiement par exécution : réservation avant génération,
// règlement au coût réel (coûts externes + marge projet) après.
import { runWithExecutionBilling } from "@/lib/billing/execution-gate";

export const runtime = "nodejs";

type Params = { params: Promise<{ projectId: string }> };

/** Storyboard Engine : découpage horodaté scène par scène + bible visuelle. */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-storyboard", rateLimit: { limit: 12, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    // Task 153 — portillon de facturation du storyboard (générations LLM).
    const { result: storyboard, billing } = await runWithExecutionBilling({
      userId: guard.context.userId,
      label: "video-storyboard",
      estimate: { task: "document", inputTokens: 8_000, outputTokens: 4_000, calls: 2, complexity: 1.2 },
      fn: () => generateStoryboard(guard.context.userId, projectId),
    });
    return NextResponse.json({ storyboard, billing });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Storyboard impossible" }, { status: errorStatus(error, 400) });
  }
}

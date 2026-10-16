import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { generateScript } from "@/lib/video/script-service";
// Task 153 — paiement par exécution : réservation avant génération,
// règlement au coût réel (coûts externes + marge projet) après.
import { runWithExecutionBilling } from "@/lib/billing/execution-gate";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ projectId: string }> };

/** Script Engine : scénario structuré complet (Hook → Chapitres → Scènes → CTA). */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-script", rateLimit: { limit: 12, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    // Task 153 — portillon de facturation du scénario (générations LLM).
    const { result, billing } = await runWithExecutionBilling({
      userId: guard.context.userId,
      label: "video-script",
      estimate: { task: "document", inputTokens: 8_000, outputTokens: 3_000, calls: 2, complexity: 1.2 },
      fn: () => generateScript(guard.context.userId, projectId),
    });
    return NextResponse.json({ ...result, billing });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Scénario impossible" }, { status: errorStatus(error, 500) });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/security/authenticated-request";
import { buildObservabilityOverview } from "@/lib/observability/queries";

/**
 * Observabilité des agents : traces, coûts, tokens, usage des outils et
 * alertes agrégés sur une fenêtre glissante (14 jours par défaut).
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const url = new URL(request.url);
    const days = Number(url.searchParams.get("days") ?? "14");
    const overview = await buildObservabilityOverview(user.uid, {
      days: Number.isFinite(days) ? days : 14,
    });
    return NextResponse.json(overview, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Observabilité indisponible" },
      { status: error instanceof Error && /auth|session|user/i.test(error.message) ? 401 : 500 },
    );
  }
}

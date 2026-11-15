import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { getTerminalEntries } from "@/lib/agents/runtime/terminal-sessions";

export const runtime = "nodejs";

/**
 * GET /api/terminal/sessions/:sessionId?since=<index>&limit=<n>
 * Entrées d'une session terminal (polling live). La propriété est vérifiée
 * côté serveur (une session d'un autre utilisateur renvoie une liste vide —
 * indiscernable d'une session vide, anti-énumération).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const user = await requireUser(request);
    const { sessionId } = await params;
    const url = new URL(request.url);
    const since = Number(url.searchParams.get("since") ?? -1);
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const entries = await getTerminalEntries(
      user.uid,
      sessionId,
      Number.isFinite(since) ? since : -1,
      Number.isFinite(limit) ? limit : 200,
    );
    return NextResponse.json({ entries });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Entrées indisponibles";
    return NextResponse.json({ error: message }, { status: errorStatus(error, 500) });
  }
}

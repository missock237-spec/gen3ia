import { NextRequest, NextResponse } from "next/server";

import { protectRoute } from "@/lib/security/route-guard";
import { listMentionConnectors } from "@/lib/integrations/mention";

export const runtime = "nodejs";

/** Sélecteur « @ » du chat agent : applications activables dans la conversation. */
export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const url = new URL(request.url);
    const search = (url.searchParams.get("q") ?? "").slice(0, 64);
    const connectors = await listMentionConnectors(guard.context.userId, search || undefined);
    return NextResponse.json({ connectors }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      connectors: [],
      error: error instanceof Error ? error.message : "Sélecteur de connecteurs indisponible.",
    }, { headers: { "cache-control": "no-store" } });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { CONNECTIONS_CATALOG, CONNECTION_CATEGORIES } from "@/lib/integrations/composio/connections";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  return NextResponse.json(
    { catalog: CONNECTIONS_CATALOG, categories: CONNECTION_CATEGORIES },
    { headers: { "cache-control": "no-store" } },
  );
}

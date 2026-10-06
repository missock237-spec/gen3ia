import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { listConnections } from "@/lib/ads/ad-connections";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  const guard = await protectRoute(request); if (!guard.ok) return guard.response;
  try {
    return NextResponse.json({ connections: await listConnections(guard.context.userId) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Chargement des connexions impossible." }, { status: errorStatus(error, 500) });
  }
}

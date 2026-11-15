import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { listAdsConnections } from "@/lib/integrations/composio/ads";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const connections = await listAdsConnections(guard.context.userId);
    return NextResponse.json(
      { connections },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to list Ads connections.",
      },
      { status: 400 },
    );
  }
}

import { NextRequest, NextResponse } from "next/server";

import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { protectRoute } from "@/lib/security/route-guard";
import { listOwnerListings, rateForListing } from "@/lib/marketplace/agent-listings";
import { listOwnerHires, listTenantHires } from "@/lib/marketplace/hire";

/**
 * « MES ACTIVITÉS » MARKETPLACE (V2, Task 114-c).
 *
 * GET /api/marketplace/agents/mine — tout pour l'utilisateur courant :
 *   { listings (ses annonces, tous statuts), hiresReceived (locations reçues
 *   sur ses agents), hiresSent (locations qu'il a louées) }.
 *
 * uid pris UNIQUEMENT du jeton (protectRoute) — cloisonnement par construction.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { key: "marketplace-mine", rateLimit: { limit: 120, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const userId = guard.context.userId;
    const [listings, hiresReceived, hiresSent] = await Promise.all([
      listOwnerListings(userId),
      listOwnerHires(userId),
      listTenantHires(userId),
    ]);
    return NextResponse.json(
      {
        listings: listings.map((listing) => ({ ...listing, rating: rateForListing(listing) })),
        hiresReceived,
        hiresSent,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: errorStatus(error, 500) });
  }
}

import { NextRequest, NextResponse } from "next/server";

import { badRequest, errorBody, errorStatus } from "@/lib/security/http-errors";
import { protectRoute } from "@/lib/security/route-guard";
import {
  PublishListingBodySchema,
  listPublishedAgentListings,
  publishAgentListing,
  rateForListing,
  type ListingSort,
} from "@/lib/marketplace/agent-listings";

/**
 * CATALOGUE MARKETPLACE D'AGENTS (V2, Task 114-c).
 *
 * GET  /api/marketplace/agents          — catalogue PUBLIC des annonces
 *                                         publiées (tri/limit/cursor) ;
 * POST /api/marketplace/agents          — publie (ou met à jour, upsert par
 *                                         agent) le listing d'un de SES
 *                                         agents — propriétaire authentifié.
 *
 * uid pris UNIQUEMENT du jeton (protectRoute : Bearer Firebase ou cookie de
 * session signé) ; erreurs canoniques errorBody/errorStatus ; rate limit.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SORTS: ReadonlySet<string> = new Set(["popular", "newest", "price_asc", "rating"]);

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { key: "marketplace-catalog", rateLimit: { limit: 120, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const url = new URL(request.url);
    const sortParam = url.searchParams.get("sort") ?? "newest";
    const sort = (SORTS.has(sortParam) ? sortParam : "newest") as ListingSort;
    const limitRaw = Number(url.searchParams.get("limit") ?? "20");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 20;
    const cursor = url.searchParams.get("cursor") ?? undefined;

    const page = await listPublishedAgentListings({ sort, limit, ...(cursor ? { cursor } : {}) });
    return NextResponse.json(
      {
        listings: page.listings.map((listing) => ({ ...listing, rating: rateForListing(listing) })),
        cursor: page.cursor,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: errorStatus(error, 500) });
  }
}

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request, { key: "marketplace-publish", rateLimit: { limit: 30, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const body: unknown = await request.json().catch(() => null);
    const parsed = PublishListingBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw badRequest("Publication invalide : titre (1-120 caractères), description (1-4000), tags (8 max) et prix entre 1 et 10 000 FCFA requis.");
    }
    const listing = await publishAgentListing(guard.context.userId, {
      agentId: parsed.data.agentId,
      title: parsed.data.title,
      description: parsed.data.description,
      capabilityTags: parsed.data.capabilityTags,
      pricing: { priceMinor: parsed.data.priceMinor },
      publish: parsed.data.publish,
    });
    return NextResponse.json(
      { listing: { ...listing, rating: rateForListing(listing) } },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: errorStatus(error, 500) });
  }
}

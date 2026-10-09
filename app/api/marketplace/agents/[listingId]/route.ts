import { NextRequest, NextResponse } from "next/server";

import { badRequest, errorBody, errorStatus } from "@/lib/security/http-errors";
import { protectRoute } from "@/lib/security/route-guard";
import {
  UpdateListingBodySchema,
  getAgentListing,
  rateForListing,
  updateAgentListing,
} from "@/lib/marketplace/agent-listings";

/**
 * DÉTAIL D'UNE ANNONCE MARKETPLACE (V2, Task 114-c).
 *
 * GET    /api/marketplace/agents/[listingId] — public pour une annonce
 *              « published » ; le PROPRIÉTAIRE voit aussi ses drafts/suspended
 *              (un autre utilisateur reçoit 404 — anti-énumération) ;
 * PATCH  /api/marketplace/agents/[listingId] — propriétaire uniquement
 *              (titre/description/tags/prix/statut) ;
 * DELETE /api/marketplace/agents/[listingId] — propriétaire uniquement :
 *              SUSPENSION douce (status « suspended » — l'historique des
 *              locations et les avis sont conservés).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ listingId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const guard = await protectRoute(request, { key: "marketplace-listing", rateLimit: { limit: 120, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const { listingId } = await params;
    const listing = await getAgentListing(listingId);
    // 404 anti-énumération : une annonce non publiée n'est visible que de
    // son propriétaire — indiscernable d'une annonce absente.
    if (!listing || (listing.status !== "published" && listing.ownerId !== guard.context.userId)) {
      return NextResponse.json({ error: "Annonce introuvable." }, { status: 404 });
    }
    return NextResponse.json(
      { listing: { ...listing, rating: rateForListing(listing) } },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: errorStatus(error, 500) });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const guard = await protectRoute(request, { key: "marketplace-listing-edit", rateLimit: { limit: 60, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const { listingId } = await params;
    const body: unknown = await request.json().catch(() => null);
    const parsed = UpdateListingBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw badRequest("Mise à jour invalide : titre (1-120), description (1-4000), tags (8 max), prix entre 1 et 10 000 FCFA ou statut (draft/published/suspended).");
    }
    const listing = await updateAgentListing(guard.context.userId, listingId, parsed.data);
    return NextResponse.json(
      { listing: { ...listing, rating: rateForListing(listing) } },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: errorStatus(error, 500) });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const guard = await protectRoute(request, { key: "marketplace-listing-delete", rateLimit: { limit: 60, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const { listingId } = await params;
    // Suspension douce : l'annonce disparaît du catalogue mais l'historique
    // (locations, avis, réputation) reste intact.
    const listing = await updateAgentListing(guard.context.userId, listingId, { status: "suspended" });
    return NextResponse.json(
      { listing: { ...listing, rating: rateForListing(listing) } },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: errorStatus(error, 500) });
  }
}

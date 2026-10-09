import { NextRequest, NextResponse } from "next/server";

import { badRequest, errorBody, errorStatus } from "@/lib/security/http-errors";
import { protectRoute } from "@/lib/security/route-guard";
import { z } from "zod";
import { upsertListingReview } from "@/lib/marketplace/agent-listings";

/**
 * NOTER UNE LOCATION (réputation marketplace — V2, Task 114-c).
 *
 * POST /api/marketplace/agents/[listingId]/rate
 *   { hireId, rating (1..5), comment? } → 201 (créé) | 200 (mis à jour)
 *   { review, rating }
 *
 * Un SEUL avis par location (doc-ID `listingId_hireId` idempotent — le
 * locataire peut corriger sa note) ; réservé au LOCATAIRE d'une location
 * « completed » ; les stats de l'annonce sont mises à jour transactionnellement.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RateBodySchema = z.object({
  hireId: z.string().trim().min(1).max(128),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1_000).optional(),
});

interface RouteContext {
  params: Promise<{ listingId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const guard = await protectRoute(request, { key: "marketplace-rate", rateLimit: { limit: 60, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const { listingId } = await params;
    const body: unknown = await request.json().catch(() => null);
    const parsed = RateBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw badRequest("Avis invalide : note de 1 à 5 étoiles et commentaire de 1 000 caractères maximum requis.");
    }
    const result = await upsertListingReview(guard.context.userId, {
      listingId,
      hireId: parsed.data.hireId,
      rating: parsed.data.rating,
      ...(parsed.data.comment !== undefined ? { comment: parsed.data.comment } : {}),
    });
    return NextResponse.json(
      { review: result.review, rating: result.rating },
      { status: result.created ? 201 : 200, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: errorStatus(error, 500) });
  }
}

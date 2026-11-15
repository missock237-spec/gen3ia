import { NextResponse } from "next/server";

import { requireAdminAccess } from "@/lib/access/platform";
import { extensionApiError } from "@/lib/extensions/api";
import { moderateReview } from "@/lib/extensions/repository";

/**
 * Modération des avis (admin uniquement).
 * POST /api/admin/extensions/reviews — body : { reviewId, action: "hide" | "show" }.
 * Idempotent ; les statistiques de l'extension suivent le statut de l'avis
 * (un avis masqué ne compte plus dans la note moyenne).
 */
export async function POST(request: Request) {
  try {
    await requireAdminAccess(request);
    const body = (await request.json().catch(() => ({}))) as { reviewId?: unknown; action?: unknown };
    const reviewId = typeof body.reviewId === "string" ? body.reviewId.trim() : "";
    const action = body.action === "hide" || body.action === "show" ? body.action : null;
    if (!reviewId || !action) {
      return NextResponse.json({ error: "reviewId et action ('hide' | 'show') sont requis." }, { status: 400 });
    }
    const review = await moderateReview({ reviewId, action });
    return NextResponse.json({
      review: {
        id: review.id,
        extensionId: review.extensionId,
        status: review.status,
        rating: review.rating,
      },
    });
  } catch (error) {
    return extensionApiError(error);
  }
}

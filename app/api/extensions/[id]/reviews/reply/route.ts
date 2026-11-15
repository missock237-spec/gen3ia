import { NextResponse } from "next/server";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { extensionApiError } from "@/lib/extensions/api";
import { replyToReview } from "@/lib/extensions/repository";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/extensions/:id/reviews/reply — le développeur de l'extension
 * répond publiquement à un avis. Body : { reviewId, reply }.
 * L'autorisation (seul le développeur propriétaire) est vérifiée dans
 * replyToReview côté serveur.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { reviewId?: unknown; reply?: unknown };
    const reviewId = typeof body.reviewId === "string" ? body.reviewId.trim() : "";
    const reply = typeof body.reply === "string" ? body.reply.trim() : "";
    if (!reviewId) return NextResponse.json({ error: "Identifiant d'avis requis." }, { status: 400 });
    if (reply.length < 2) {
      return NextResponse.json({ error: "La réponse doit contenir au moins 2 caractères." }, { status: 400 });
    }
    const review = await replyToReview({
      extensionId: id,
      developerId: token.uid,
      reviewId,
      reply,
    });
    return NextResponse.json({
      review: {
        id: review.id,
        rating: review.rating,
        body: review.body,
        developerReply: review.developerReply ?? null,
      },
    });
  } catch (error) {
    return extensionApiError(error);
  }
}

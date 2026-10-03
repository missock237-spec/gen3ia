import { NextResponse } from "next/server";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { extensionApiError } from "@/lib/extensions/api";
import { getInstallation, listReviews, upsertReview } from "@/lib/extensions/repository";

type Params = { params: Promise<{ id: string }> };

const ReviewSchemaBody = { min: 1, max: 5 } as const;

/** GET /api/extensions/:id/reviews — visible reviews. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const reviews = await listReviews(id);
    return NextResponse.json({
      reviews: reviews.map((review) => ({
        userId: `${review.userId.slice(0, 6)}…`,
        rating: review.rating,
        title: review.title ?? null,
        body: review.body,
        developerReply: review.developerReply ?? null,
        createdAt: review.createdAt,
      })),
    });
  } catch (error) {
    return extensionApiError(error);
  }
}

/** POST /api/extensions/:id/reviews — review, installers only. Body: { rating, title?, body } */
export async function POST(request: Request, { params }: Params) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    const installation = await getInstallation(id, token.uid);
    if (!installation || installation.status === "uninstalled") {
      return NextResponse.json({ error: "Installez d'abord l'extension pour la noter." }, { status: 403 });
    }
    const body = (await request.json().catch(() => ({}))) as { rating?: unknown; title?: unknown; body?: unknown };
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < ReviewSchemaBody.min || rating > ReviewSchemaBody.max) {
      return NextResponse.json({ error: "La note doit être un entier entre 1 et 5." }, { status: 400 });
    }
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (text.length < 4) {
      return NextResponse.json({ error: "Le commentaire doit contenir au moins 4 caractères." }, { status: 400 });
    }
    await upsertReview({
      extensionId: id,
      userId: token.uid,
      rating,
      title: typeof body.title === "string" ? body.title.slice(0, 120) : undefined,
      body: text,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return extensionApiError(error);
  }
}

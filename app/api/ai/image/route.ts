import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import {
  editImageWithAgnes,
  generateImageWithAgnes,
  IMAGE_RATIOS,
  IMAGE_SIZES,
  ImageGenerationError,
  isImageGenerationEnabled,
  MAX_EDIT_IMAGES,
} from "@/lib/ai/image-generation";

/**
 * Génération d'images réelle (Agnes AI) — endpoint dédié.
 *
 * Utilisé par le chat d'agent IA : l'utilisateur demande une
 * image en langage naturel, le serveur détecte l'intention et/ou l'UI appelle
 * directement cet endpoint. Authentification obligatoire + quota par
 * utilisateur (la clé Agnes est partagée par toute la plateforme).
 */

export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z.object({
  prompt: z.string().trim().min(3).max(4000),
  size: z.enum(IMAGE_SIZES).default("1K"),
  ratio: z.enum(IMAGE_RATIOS).default("1:1"),
  /**
   * Étape 8 — images sources d'ÉDITION (Data URI Base64 ou URL https
   * publique). Présentes → image-to-image ; absentes → génération.
   */
  images: z.array(z.string().trim().min(8)).max(MAX_EDIT_IMAGES).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);

    if (!isImageGenerationEnabled()) {
      return NextResponse.json(
        { error: "La génération d'images n'est pas encore disponible. Réessayez bientôt.", code: "CONFIGURATION_REQUIRED" },
        { status: 503 },
      );
    }

    // Quota dédié : 12 images / 5 minutes / utilisateur (protège la clé
    // partagée sans gêner un usage conversationnel normal).
    const limit = await enforceRateLimit(`ai-image:${user.uid}`, { limit: 12, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Limite de génération d'images atteinte. Réessayez dans quelques minutes.", code: "RATE_LIMITED" },
        { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))) } },
      );
    }

    const body = Body.parse(await request.json());
    const image = body.images && body.images.length > 0
      ? await editImageWithAgnes({ prompt: body.prompt, images: body.images, size: body.size, ratio: body.ratio })
      : await generateImageWithAgnes(body);

    return NextResponse.json({
      imageUrl: image.imageUrl,
      model: image.model,
      taskId: image.taskId,
      latencyMs: image.latencyMs,
      ...(body.images && body.images.length > 0 ? { edited: true, sourceCount: body.images.length } : {}),
    });
  } catch (error) {
    if (error instanceof ImageGenerationError) {
      const status = error.code === "NOT_CONFIGURED" ? 503 : error.code === "TIMEOUT" ? 504 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    const body = errorBody(error, "La génération d'image a échoué.");
    return NextResponse.json({ error: body.error, code: body.code }, { status: errorStatus(error, 400) });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { recordFeedback, FEEDBACK_CATEGORIES } from "@/lib/ai/feedback";
import { errorStatus } from "@/lib/security/http-errors";

/**
 * POST /api/ai/feedback — retour utilisateur sur une réponse de l'agent
 * (Task 42, axe 2 : apprentissage continu sûr).
 *
 * Pipeline : chaque retour est stocké cloisonné par utilisateur ; les
 * retours négatifs créent/confirment une leçon PAR CATÉGORIE (seuil de
 * confirmation avant activation — voir lib/ai/feedback.ts). Les leçons
 * actives sont injectées dans le contexte de planification Gen IA.
 */

const BodySchema = z.object({
  conversationId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(128),
  rating: z.enum(["up", "down"]),
  category: z.enum(FEEDBACK_CATEGORIES as unknown as [string, ...string[]]).optional(),
  reason: z.string().max(600).optional(),
});

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request, { key: "ai-feedback", rateLimit: { limit: 60, windowMs: 60 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const body = BodySchema.parse(await request.json());
    const result = await recordFeedback({
      userId: guard.context.userId,
      conversationId: body.conversationId,
      messageId: body.messageId,
      rating: body.rating,
      category: body.category as never,
      reason: body.reason,
    });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: "Feedback refusé." }, { status: errorStatus(error) });
  }
}

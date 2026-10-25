import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { recordFeedback, FEEDBACK_CATEGORIES } from "@/lib/ai/feedback";
import { errorStatus } from "@/lib/security/http-errors";
import { getNeuralRuntime } from "@/lib/neural/runtime";

/**
 * POST /api/ai/feedback — retour utilisateur sur une réponse de l'agent
 * (Task 42, axe 2 : apprentissage continu sûr).
 *
 * Pipeline : chaque retour est stocké cloisonné par utilisateur ; les
 * retours négatifs créent/confirment une leçon PAR CATÉGORIE (seuil de
 * confirmation avant activation — voir lib/ai/feedback.ts). Les leçons
 * actives sont injectées dans le contexte de planification Gen IA.
 *
 * PLASTICITÉ PAR FEEDBACK (2026-10-25) : si le client transmet `pairKey`
 * (clé de motif de la paire du cortex gagnante, exposée par l'événement
 * turn_telemetry), le signal humain pilote DIRECTEMENT la plasticité
 * d'usage du cortex langagier : 👍 renforce (+gain×2), 👎 affaiblit
 * (×0.85, plancher 0.6). Fail-soft total : une plasticité impossible ne
 * refuse jamais le stockage du feedback.
 */

const BodySchema = z.object({
  conversationId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(128),
  rating: z.enum(["up", "down"]),
  category: z.enum(FEEDBACK_CATEGORIES as unknown as [string, ...string[]]).optional(),
  reason: z.string().max(600).optional(),
  /** Clé de motif cortex (télémétrie turn_telemetry.raw.langage.cle). */
  pairKey: z.string().min(1).max(256).optional(),
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

    // Plasticité directe du cortex (fail-soft) — le signal humain améliore
    // réellement les rappels suivants au lieu de ne servir qu'aux stats.
    let plasticity: "renforcee" | "affaiblie" | "ignoree" = "ignoree";
    if (body.pairKey) {
      try {
        const { cortex } = getNeuralRuntime();
        const applique = body.rating === "up"
          ? cortex.renforcer(body.pairKey)
          : cortex.affaiblir(body.pairKey);
        plasticity = applique
          ? body.rating === "up" ? "renforcee" : "affaiblie"
          : "ignoree";
      } catch {
        // Runtime indisponible (cold start…) : le feedback reste stocké.
      }
    }

    return NextResponse.json(
      { ...result, plasticity },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json({ error: "Feedback refusé." }, { status: errorStatus(error) });
  }
}

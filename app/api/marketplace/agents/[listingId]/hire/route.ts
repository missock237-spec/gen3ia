import { NextRequest, NextResponse } from "next/server";

import { badRequest, errorBody, errorStatus } from "@/lib/security/http-errors";
import { protectRoute } from "@/lib/security/route-guard";
import { z } from "zod";
import { hireAgent } from "@/lib/marketplace/hire";

/**
 * LOUER UN AGENT PUBLIÉ (V2, Task 114-c).
 *
 * POST /api/marketplace/agents/[listingId]/hire
 *   { objective, conversationId? } → 202
 *   { hireId, runId, executionId, priceMinor, pollUrl }
 *
 * Le loyer (prix fixe du listing) est RÉSERVÉ sur le wallet du locataire ;
 * à la LIVRAISON réussie de la mission il est capturé puis scindé
 * (commission plateforme / gain du propriétaire) ; sur échec il est libéré.
 * Suivi : pollUrl = /api/agents/runs/{runId} (scopé locataire).
 *
 * Erreurs FR canoniques : 400 (objectif invalide), 401, 402 (solde
 * insuffisant), 403 (auto-location), 404 (annonce absente), 409 (annonce non
 * publiée / agent indisponible), 503 (file de missions indisponible).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HireBodySchema = z.object({
  objective: z.string().trim().min(1).max(4_000),
  conversationId: z.string().trim().min(1).max(128).optional(),
});

interface RouteContext {
  params: Promise<{ listingId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const guard = await protectRoute(request, { key: "marketplace-hire", rateLimit: { limit: 20, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const { listingId } = await params;
    const body: unknown = await request.json().catch(() => null);
    const parsed = HireBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw badRequest("Location invalide : décrivez la mission de l'agent en 1 à 4 000 caractères.");
    }

    const result = await hireAgent(guard.context.userId, {
      listingId,
      objective: parsed.data.objective,
      conversationId: parsed.data.conversationId,
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json(
      {
        hireId: result.hireId,
        runId: result.runId,
        executionId: result.executionId,
        priceMinor: result.priceMinor,
        pollUrl: `/api/agents/runs/${result.runId}`,
      },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: errorStatus(error, 500) });
  }
}

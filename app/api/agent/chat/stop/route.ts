import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { requestExecutionStop } from "@/lib/agents/runtime/pause";

export const runtime = "nodejs";

const Body = z.object({
  executionId: z.string().trim().min(1).max(256),
});

/**
 * ARRÊT EXPLICITE d'une mission en cours (exigence production : seul un
 * arrêt DÉCIDÉ doit interrompre un agent — jamais un refresh, une fermeture
 * d'onglet ou une coupure réseau).
 *
 * Le contrôle Firestore `agentPauseControls` (mode "stop") est consulté par
 * le runtime entre les lots d'étapes ET avant chaque étape, que la mission
 * s'exécute en synchrone ou dans la file (mission-tick) : l'arrêt prend
 * effet au plus près de l'étape en cours, sans jamais couper un appel
 * LLM/outil à moitié, et le travail déjà payé reste conservé.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`agent-stop:${user.uid}`, { limit: 30, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop de demandes rapprochées. Réessayez dans un instant." }, { status: 429 });
    }
    const body = Body.parse(await request.json());
    await requestExecutionStop({
      userId: user.uid,
      executionId: body.executionId,
      reason: "Arrêt demandé par l'utilisateur depuis le chat.",
    });
    return NextResponse.json({ ok: true, status: "stop_requested", executionId: body.executionId });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Arrêt impossible." },
      { status: errorStatus(error, 400) },
    );
  }
}

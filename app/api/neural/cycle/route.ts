import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { executionLogger } from "@/lib/observability/logger";

import { getNeuralRuntime } from "@/lib/neural/runtime";

/**
 * CYCLE NEURONAL — parle au cerveau Gen3 : le message est encodé en stimulations
 * de la zone de tokens (hachage FNV-1a), une fenêtre de cycles réels s'exécute
 * via le noyau central, les résonances des pools de sortie sont lues (décodage
 * par latence) et la réponse honnête est décodée en français.
 *
 * Le corps des effecteurs (Tool OS, compétences, média, vocal) est interrogé
 * à chaque cycle : toute action déclenchée par résonance ≥ 0.80 est retournée.
 */
export const dynamic = "force-dynamic";

const CycleBodySchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, "Le message ne peut pas être vide.")
    .max(4000, "Le message est trop long (4000 caractères maximum)."),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);

    const body = CycleBodySchema.parse(await request.json());
    const runtime = getNeuralRuntime();

    const reponse = await runtime.engine.generate({
      task: "chat",
      messages: [{ role: "user", content: body.message }],
    });

    executionLogger({
      requestId: "neural-cycle",
      userId: user.uid,
    }).info("Cycle neuronal exécuté");

    return NextResponse.json({
      reponse: {
        texte: reponse.text,
        model: reponse.model,
        usage: reponse.usage,
        latencyMs: reponse.latencyMs,
        ...((reponse.raw as Record<string, unknown>) ?? {}),
      },
      sante: { ...runtime.noyau.metriquesSante },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur inconnue." },
      { status: errorStatus(error, 500) },
    );
  }
}

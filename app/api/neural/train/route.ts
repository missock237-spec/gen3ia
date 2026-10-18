import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { requireAdmin } from "@/lib/security/admin-access";
import { errorStatus } from "@/lib/security/http-errors";

import { getDernierJob, lancerEntrainement } from "@/lib/neural/training/job";
import { getNeuralRuntime } from "@/lib/neural/runtime";

/**
 * ENTRAÎNEMENT NEURONAL — lance (admin) ou observe (tous) l'entraînement réel
 * du cerveau Gen3 sur le corpus du projet (public/llms*.txt + amorçage
 * canonique supervisé).
 *
 * POST (admin) : boucle supervisée RÉELLE — plasticité synaptique guidée par
 * label, accuracy mesurée par époque, évaluation sur jeu de test jamais vu,
 * puis persistance du cerveau appris (var/neural/brain-v1.json).
 * GET : progression du job en cours / dernier rapport.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TrainBodySchema = z.object({
  epochs: z.number().int().min(1).max(10).optional(),
  maxParLabel: z.number().int().min(1).max(500).optional(),
  maxTotal: z.number().int().min(2).max(8000).optional(),
  lrBoost: z.number().min(0.01).max(0.5).optional(),
  cyclesParEchantillon: z.number().int().min(2).max(8).optional(),
});

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);

    const body = TrainBodySchema.parse(await request.json().catch(() => ({})));
    const job = lancerEntrainement(body);

    return NextResponse.json(
      {
        job,
        message:
          "Entraînement lancé — la progression est observable via GET /api/neural/train.",
      },
      { status: 202 },
    );
  } catch (error) {
    const conflit =
      error instanceof Error && error.message.includes("déjà en cours");
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur inconnue." },
      { status: conflit ? 409 : errorStatus(error, 500) },
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    await requireUser(request);

    const job = getDernierJob();
    const runtime = getNeuralRuntime();

    return NextResponse.json({
      job,
      cerveau: {
        nbSynapses: runtime.reseau.getStats().nbSynapses,
        historiqueEntrainements: runtime.historiqueEntrainement.length,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur inconnue." },
      { status: errorStatus(error, 500) },
    );
  }
}

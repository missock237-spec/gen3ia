import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";

import { generateTrainingPlan } from "@/lib/training/assistant";
import { getProject, savePlan } from "@/lib/training/repository";

/**
 * POST /api/training/projects/[id]/analysis
 * Lance l'analyse de l'assistant IA : produit un plan d'entraînement PROPOSÉ
 * fondé sur les métadonnées réelles (assets, datasets, moteurs). Repli
 * heuristique déterministe si l'IA est indisponible — plan étiqueté comme tel.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const project = await getProject(user.uid, id);
    if (!project) {
      return NextResponse.json({ error: "Projet introuvable.", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }

    // Une analyse IA est coûteuse : 5 par minute et par utilisateur.
    const limit = await enforceRateLimit(`training-analysis:${user.uid}`, { limit: 5, windowMs: 60_000 });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop d'analyses demandées : patientez une minute.", requestId },
        { status: 429, headers: { "x-request-id": requestId } },
      );
    }

    const result = await generateTrainingPlan(user.uid, id);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }
    await savePlan(user.uid, result.plan);
    return NextResponse.json(
      { plan: result.plan, generatedBy: result.generatedBy, explanation: result.explanation, requestId },
      { status: 201, headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Analyse impossible pour le moment"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}

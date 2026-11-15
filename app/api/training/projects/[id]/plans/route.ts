import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

import { getProject, getProjectOverview, listPlans, savePlan } from "@/lib/training/repository";
import { planCoherenceErrors } from "@/lib/training/assistant";
import { trainingMethodSchema } from "@/lib/training/types";

/** GET /api/training/projects/[id]/plans — historique des plans du projet. */
export async function GET(
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
    const plans = await listPlans(user.uid, id);
    return NextResponse.json({ plans, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Liste des plans indisponible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}

const patchPlanSchema = z.object({
  planId: z.string().min(1),
  method: trainingMethodSchema.optional(),
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  /** Refus explicite d'un plan proposé (le rend inactif sans créer de tâche). */
  status: z.enum(["rejected"]).optional(),
});

/**
 * PATCH /api/training/projects/[id]/plans — modification d'un plan PROPOSÉ
 * (mode avancé : l'utilisateur ajuste la méthode/paramètres avant acceptation).
 * La cohérence avec les capacités du moteur est revérifiée côté serveur.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const overview = await getProjectOverview(user.uid, id);
    if (!overview) {
      return NextResponse.json({ error: "Projet introuvable.", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }
    const body = (await request.json().catch(() => null)) as unknown;
    const parsed = patchPlanSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Corps de modification de plan invalide.", requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }
    const plan = overview.plans.find((p) => p.id === parsed.data.planId);
    if (!plan) {
      return NextResponse.json({ error: "Plan introuvable.", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }
    if (plan.status !== "proposed") {
      return NextResponse.json(
        { error: "Seul un plan à l'état « proposé » peut être modifié.", requestId },
        { status: 409, headers: { "x-request-id": requestId } },
      );
    }
    const updated = {
      ...plan,
      method: parsed.data.method ?? plan.method,
      parameters: parsed.data.parameters ?? plan.parameters,
      ...(parsed.data.status === "rejected" ? { status: "rejected" as const } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (parsed.data.status !== "rejected") {
      const errors = planCoherenceErrors(updated);
      if (errors.length > 0) {
        return NextResponse.json(
          { error: errors.join(" "), requestId },
          { status: 422, headers: { "x-request-id": requestId } },
        );
      }
    }
    await savePlan(user.uid, updated);
    return NextResponse.json({ plan: updated, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Modification du plan impossible"), requestId },
      { status: errorStatus(error, 400), headers: { "x-request-id": requestId } },
    );
  }
}

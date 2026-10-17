import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

import { getProject, getPlan, savePlan } from "@/lib/training/repository";
import { ipFromRequest, recordTrainingAudit } from "@/lib/training/audit";
import { createJobFromPlan } from "@/lib/training/orchestrator";
import { planCoherenceErrors } from "@/lib/training/assistant";

/**
 * POST /api/training/plans/[planId]/accept — accepte un plan et crée la tâche
 * d'entraînement (dispatch immédiat si un fournisseur GPU est disponible,
 * file d'attente honnête sinon).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ planId: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { planId } = await params;
    const body = (await request.json().catch(() => ({}))) as { projectId?: unknown } | null;
    const projectId = typeof body?.projectId === "string" ? body.projectId : "";
    if (!projectId) {
      return NextResponse.json(
        { error: "projectId requis dans le corps de la requête.", requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }

    const project = await getProject(user.uid, projectId);
    if (!project) {
      return NextResponse.json({ error: "Projet introuvable.", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }
    const plan = await getPlan(user.uid, projectId, planId);
    if (!plan) {
      return NextResponse.json({ error: "Plan introuvable.", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }
    if (plan.status !== "proposed") {
      return NextResponse.json(
        { error: `Ce plan est déjà à l'état « ${plan.status} » : seul un plan proposé peut être accepté.`, requestId },
        { status: 409, headers: { "x-request-id": requestId } },
      );
    }

    const coherence = planCoherenceErrors(plan);
    if (coherence.length > 0) {
      return NextResponse.json(
        { error: coherence.join(" "), requestId },
        { status: 422, headers: { "x-request-id": requestId } },
      );
    }

    const result = await createJobFromPlan(user.uid, plan);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, requestId },
        { status: 409, headers: { "x-request-id": requestId } },
      );
    }

    await savePlan(user.uid, { ...plan, status: "accepted", acceptedAt: new Date().toISOString() });
    void recordTrainingAudit({
      uid: user.uid,
      action: "plan.accepted",
      entityType: "plan",
      entityId: plan.id,
      projectId,
      ip: ipFromRequest(request),
      details: { method: plan.method, engineId: plan.engineId, jobId: result.job.id },
    }).catch(() => undefined);
    void recordTrainingAudit({
      uid: user.uid,
      action: "job.created",
      entityType: "job",
      entityId: result.job.id,
      projectId,
      ip: ipFromRequest(request),
      details: { status: result.job.status, waitingReason: result.job.waitingReason ?? null, simulated: result.job.simulated },
    }).catch(() => undefined);
    return NextResponse.json(
      { job: result.job, requestId },
      { status: 201, headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Acceptation du plan impossible"), requestId },
      { status: errorStatus(error, 400), headers: { "x-request-id": requestId } },
    );
  }
}

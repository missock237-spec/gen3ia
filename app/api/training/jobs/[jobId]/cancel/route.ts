import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

import { getProject } from "@/lib/training/repository";
import { ipFromRequest, recordTrainingAudit } from "@/lib/training/audit";
import { cancelJob } from "@/lib/training/orchestrator";

/** POST /api/training/jobs/[jobId]/cancel — annule une tâche (propagée au fournisseur GPU). */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { jobId } = await params;
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
    const job = await cancelJob(user.uid, projectId, jobId);
    if (!job) {
      return NextResponse.json({ error: "Tâche introuvable.", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }
    void recordTrainingAudit({
      uid: user.uid,
      action: "job.cancelled",
      entityType: "job",
      entityId: job.id,
      projectId,
      ip: ipFromRequest(request),
      details: { status: job.status },
    }).catch(() => undefined);
    return NextResponse.json({ job, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Annulation impossible"), requestId },
      { status: errorStatus(error, 400), headers: { "x-request-id": requestId } },
    );
  }
}

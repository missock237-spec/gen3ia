import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireSystemAccess } from "@/app/api/training/_internal/system-only";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

import { getJob, getProject } from "@/lib/training/repository";
import { refreshJob } from "@/lib/training/orchestrator";
import { saveJob } from "@/lib/training/repository";

/**
 * GET /api/training/jobs/[jobId]?projectId=… — SYSTÈME-ONLY (demande n° 6).
 *
 * Le détail brut d'une tâche + le rafraîchissement fournisseur piloté par
 * requête (`refreshJob`) relèvent de la mécanique interne : 403 JSON clair
 * pour un utilisateur standard (401 si non authentifié). L'utilisateur suit
 * progression, journal et métriques via `GET /api/training/projects/[id]`,
 * dont le sweep interne rafraîchit les tâches en cours.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireSystemAccess(request);
    const { jobId } = await params;
    const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
    if (!projectId) {
      return NextResponse.json(
        { error: "projectId requis en paramètre de requête.", requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }
    const project = await getProject(user.uid, projectId);
    if (!project) {
      return NextResponse.json({ error: "Projet introuvable.", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }
    let job = await getJob(user.uid, projectId, jobId);
    if (!job) {
      return NextResponse.json({ error: "Tâche introuvable.", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }
    if (job.status === "running") {
      const refreshed = await refreshJob(user.uid, job);
      if (refreshed !== job) {
        job = refreshed;
        await saveJob(user.uid, job);
      }
    }
    return NextResponse.json({ job, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Tâche indisponible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}

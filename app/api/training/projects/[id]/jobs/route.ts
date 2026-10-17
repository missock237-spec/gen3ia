import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

import { getProject, listJobs } from "@/lib/training/repository";
import { sweepUserJobs } from "@/lib/training/orchestrator";

/** GET /api/training/projects/[id]/jobs — tâches du projet (+ sweep opportuniste). */
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
    // Sweep : dispatch des tâches en attente / rafraîchissement des en cours.
    const sweep = await sweepUserJobs(user.uid).catch(() => ({ dispatched: 0, refreshed: 0 }));
    const jobs = await listJobs(user.uid, id);
    return NextResponse.json({ jobs, sweep, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Liste des tâches indisponible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}

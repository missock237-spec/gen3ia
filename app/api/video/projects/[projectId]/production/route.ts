import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { getOwnedProjectOrThrow } from "@/lib/video/project-service";
import {
  listProductionJobs,
  sweepStaleProductionJobs,
  maybeAdvancePendingProductionJob,
  PRODUCTION_POLL_ADVANCE_BUDGET_MS,
  type VideoProductionJob,
} from "@/lib/video/production-queue";
import { qstashConfig } from "@/lib/queue/qstash";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ projectId: string }> };

/**
 * Statut de la production autopilote du projet (Task 1-a FIX 7) — lecture
 * propriétaire (même garde protectRoute que les routes sœurs) ET moteur de
 * continuation par sondage : sweep des jobs orphelins + avance D'UN tick
 * borné du job en attente DANS cette requête. Sans QStash, la production
 * avance tant que le client garde la page ouverte ; le claim transactionnel
 * (bail) garantit qu'un sondage concurrent ne peut pas doubler un tick.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-production-status", rateLimit: { limit: 240, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    // Cloisonnement propriétaire strict (anti-énumération).
    await getOwnedProjectOrThrow(guard.context.userId, projectId);
    const origin = process.env.GEN3IA_APP_ORIGIN?.trim() || request.nextUrl.origin;

    // Sweep best-effort : les jobs orphelins repassent en file (ou échouent
    // proprement) avant l'avance par sondage.
    await sweepStaleProductionJobs(origin).catch(() => undefined);

    const jobs = await listProductionJobs(guard.context.userId, projectId);
    const job: VideoProductionJob | undefined = jobs[0];
    let pendingTicked = false;
    if (job && (job.status === "queued" || job.status === "processing")) {
      // UN tick borné par poll (~55 s max, checkpoint entre scènes).
      const ticked = await maybeAdvancePendingProductionJob(job.id, { origin, timeBudgetMs: PRODUCTION_POLL_ADVANCE_BUDGET_MS }).catch(() => null);
      pendingTicked = ticked !== null;
    }

    // Relecture post-tick (le tick a pu avancer l'étape ou terminer le job).
    const current = pendingTicked ? (await listProductionJobs(guard.context.userId, projectId))[0] : job;
    if (!current) {
      return NextResponse.json({ job: null, queueMode: qstashConfig() ? ("qstash" as const) : ("poll" as const) });
    }
    return NextResponse.json({
      jobId: current.id,
      projectId: current.projectId,
      status: current.status,
      stage: current.stage,
      stageIndex: current.stageIndex,
      progress: current.progress,
      error: current.error ?? null,
      renderJobId: current.renderJobId ?? null,
      timeline: current.timeline,
      sceneCursor: current.sceneCursor,
      title: current.title,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      queueMode: qstashConfig() ? ("qstash" as const) : ("poll" as const),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Statut de production indisponible" },
      { status: errorStatus(error, 400) },
    );
  }
}

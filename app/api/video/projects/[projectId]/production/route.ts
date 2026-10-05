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
import { cacheGet, cacheSet } from "@/lib/cache/redis";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ projectId: string }> };

// ────────────────────────────────────────────────────────────────────────────
// Lot C4a (quota Firestore) — sweep retiré du chemin chaud du GET (miroir du
// rendu, voir render/route.ts pour le raisonnement complet) :
//  - mode QStash  : sweep SUPPRIMÉ du GET — le worker production-tick
//    (app/api/video/worker/production-tick/route.ts) balaie déjà les
//    orphelins à chaque délivrance.
//  - mode sondage (QStash absent) : sweep THROTTLÉ à 1 exécution / minute /
//    projet — clé Redis partagée `g3:sweep:production:{projectId}` (TTL
//    60 s), repli mémoire process-local défensif serverless.
// ────────────────────────────────────────────────────────────────────────────

const SWEEP_THROTTLE_MS = 60_000;

/** Horodatage du dernier sweep par clé — repli local si Redis est absent. */
const localSweepAt = new Map<string, number>();

async function sweepProductionJobsIfDue(projectId: string, origin: string): Promise<void> {
  // Mode QStash : le worker production-tick est déjà responsable du sweep.
  if (qstashConfig()) return;
  const throttleKey = `sweep:production:${projectId}`;
  const now = Date.now();
  const localAt = localSweepAt.get(throttleKey);
  if (typeof localAt === "number" && now - localAt < SWEEP_THROTTLE_MS) return;
  const sharedAt = await cacheGet<number>(throttleKey);
  if (typeof sharedAt === "number" && now - sharedAt < SWEEP_THROTTLE_MS) {
    // Synchronise l'horloge locale sur la décision partagée (évite de
    // re-interroger Redis à chaque tick pendant la fenêtre).
    localSweepAt.set(throttleKey, sharedAt);
    return;
  }
  localSweepAt.set(throttleKey, now);
  await cacheSet(throttleKey, now, Math.ceil(SWEEP_THROTTLE_MS / 1000));
  await sweepStaleProductionJobs(origin).catch(() => undefined);
}

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

    // Sweep best-effort des jobs orphelins — throttlé (lot C4a, voir
    // sweepProductionJobsIfDue) : supprimé en mode QStash, 1 exécution max
    // par minute sinon.
    await sweepProductionJobsIfDue(projectId, origin);

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

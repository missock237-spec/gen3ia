import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { getOwnedProjectOrThrow } from "@/lib/video/project-service";
import {
  deliverJobToConversation,
  listProductionJobs,
  sweepStaleProductionJobs,
  maybeAdvancePendingProductionJob,
  PRODUCTION_POLL_ADVANCE_BUDGET_MS,
  PRODUCTION_JOBS_COLLECTION,
  type VideoProductionJob,
} from "@/lib/video/production-queue";
import { writeCheckpointSet } from "@/lib/db/firestore-resilient";
import { getJob as getRenderJob } from "@/lib/video/render-queue";
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
//    projet — clé de throttle `g3:sweep:production:{projectId}` (TTL
//    60 s), repli mémoire process-local défensif serverless.
// ────────────────────────────────────────────────────────────────────────────

const SWEEP_THROTTLE_MS = 60_000;

/** Horodatage du dernier sweep par clé — cache process-local. */
const localSweepAt = new Map<string, number>();

async function sweepProductionJobsIfDue(projectId: string): Promise<void> {
  // Mode QStash : le worker production-tick est déjà responsable du sweep.
  if (qstashConfig()) return;
  const throttleKey = `sweep:production:${projectId}`;
  const now = Date.now();
  const localAt = localSweepAt.get(throttleKey);
  if (typeof localAt === "number" && now - localAt < SWEEP_THROTTLE_MS) return;
  const sharedAt = await cacheGet<number>(throttleKey);
  if (typeof sharedAt === "number" && now - sharedAt < SWEEP_THROTTLE_MS) {
    // Synchronise l'horloge locale sur la décision partagée (évite de
    // re-purger la Map à chaque tick pendant la fenêtre).
    localSweepAt.set(throttleKey, sharedAt);
    return;
  }
  localSweepAt.set(throttleKey, now);
  await cacheSet(throttleKey, now, Math.ceil(SWEEP_THROTTLE_MS / 1000));
  // ORIGINE CANONIQUE (fix CodeQL request-forgery) : le sweep et les ticks
  // résolvent GEN3IA_APP_ORIGIN en interne — plus aucune origine requête.
  await sweepStaleProductionJobs().catch(() => undefined);
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

    // Sweep best-effort des jobs orphelins — throttlé (lot C4a, voir
    // sweepProductionJobsIfDue) : supprimé en mode QStash, 1 exécution max
    // par minute sinon.
    await sweepProductionJobsIfDue(projectId);

    const jobs = await listProductionJobs(guard.context.userId, projectId);
    let job: VideoProductionJob | undefined = jobs[0];

    // ROBUSTESSE LIVRAISON (sonde sticky — fix captures 13:02, exigence
    // « chaque exécution réellement fournie à l'utilisateur ») : un job
    // « processing / stage=done » dont le rendu rattaché est TERMINÉ est une
    // vidéo FINIE dont l'écriture terminale (Firestore) est momentanément
    // indisponible (quota/incident) — le job ne peut plus être « claimé »
    // (transaction Firestore) et la livraison chat ne partait JAMAIS. La
    // livraison (appendMessage = stockage R2, indépendant de Firestore) part
    // IMMÉDIATEMENT, le client voit « completed », et l'écriture terminale
    // reste best-effort (le tick finalisera le statut stocké à la reprise ;
    // l'anti-doublon interne de la livraison empêche tout second message).
    if (job && job.status === "processing" && job.stage === "done" && job.renderJobId) {
      try {
        const renderJob = await getRenderJob(job.renderJobId);
        if (renderJob?.status === "completed") {
          const effective: VideoProductionJob = { ...job, status: "completed", progress: 1 };
          await deliverJobToConversation(effective);
          await writeCheckpointSet(
            PRODUCTION_JOBS_COLLECTION,
            job.id,
            { status: "completed", progress: 1, updatedAt: new Date().toISOString() },
            job.userId,
          ).catch(() => undefined);
          job = effective;
        }
      } catch {
        // Lecture rendu indisponible : statut stocké conservé (comportement
        // antérieur) — la récupération retentera au prochain sondage.
      }
    }

    let pendingTicked = false;
    if (job && (job.status === "queued" || job.status === "processing")) {
      // UN tick borné par poll (~55 s max, checkpoint entre scènes).
      const ticked = await maybeAdvancePendingProductionJob(job.id, { timeBudgetMs: PRODUCTION_POLL_ADVANCE_BUDGET_MS }).catch(() => null);
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

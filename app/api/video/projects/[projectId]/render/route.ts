import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { RenderRequestSchema } from "@/lib/video/security";
import { startRenderJob, listJobs, pauseJob, resumeJob, cancelJob, sweepStaleRenderJobs, maybeAdvancePendingJob, POLL_ADVANCE_BUDGET_MS } from "@/lib/video/render-queue";
import { checkFfmpegAvailable } from "@/lib/video/ffmpeg";
import { qstashConfig } from "@/lib/queue/qstash";
import { isImageGenerationEnabled } from "@/lib/ai/image-generation";
import { getJobProgress } from "@/lib/infra/upstash";
import { cacheGet, cacheSet } from "@/lib/cache/redis";

export const runtime = "nodejs";
export const maxDuration = 60;

type Params = { params: Promise<{ projectId: string }> };

// ────────────────────────────────────────────────────────────────────────────
// Lot C4a (quota Firestore) — sweep retiré du chemin chaud du GET.
//
// Le balayage des jobs orphelins scanne jusqu'à 200 jobs « processing » DE
// TOUS LES UTILISATEURS ; l'exécuter à chaque tick de poll (4-5 s) coûtait
// des centaines de lectures par sondage. Désormais :
//  - mode QStash  : le sweep est SUPPRIMÉ du GET — le worker tick
//    (app/api/video/worker/tick/route.ts) balaie déjà les orphelins à
//    chaque délivrance ; les jobs à bail expiré restent de plus récupérables
//    par la continuation par sondage (claim transactionnel ci-dessous).
//  - mode sondage (QStash absent) : le GET reste le seul récupérateur —
//    sweep THROTTLÉ à 1 exécution / minute / projet : clé Redis partagée
//    `g3:sweep:render:{projectId}` (TTL 60 s, préfixe g3: posé par le
//    client), repli mémoire process-local défensif serverless (Redis
//    absent/indisponible → la clé locale seule borne la fréquence par
//    instance).
// ────────────────────────────────────────────────────────────────────────────

const SWEEP_THROTTLE_MS = 60_000;

/** Horodatage du dernier sweep par clé — repli local si Redis est absent. */
const localSweepAt = new Map<string, number>();

async function sweepRenderJobsIfDue(projectId: string): Promise<void> {
  // Mode QStash : le worker tick est déjà responsable du sweep — aucun
  // second balayage cross-user dans le GET.
  if (qstashConfig()) return;
  const throttleKey = `sweep:render:${projectId}`;
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
  // ORIGINE CANONIQUE (fix CodeQL request-forgery) : le sweep et les ticks
  // résolvent GEN3IA_APP_ORIGIN en interne — plus aucune origine requête.
  await sweepStaleRenderJobs().catch(() => undefined);
}

/**
 * Démarre un rendu (file QStash, checkpoints, reprise, budget réservé).
 *
 * Préflight HONNÊTE (Task 1-a FIX 6d) : FFmpeg est vérifié AVANT de créer
 * le job — un rendu impossible ne consomme pas de réservation et reçoit un
 * message de réparation actionnable. QStash absent n'est PAS bloquant :
 * la continuation par sondage (GET) et le worker local couvrent — le mode
 * effectif est retourné dans `queueMode`.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-render-start", rateLimit: { limit: 8, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const { derivedTargets } = RenderRequestSchema.parse(await request.json().catch(() => ({})));

    // Préflight FFmpeg (binaire réel : env → ffmpeg-static → PATH).
    const ffmpeg = await checkFfmpegAvailable();
    if (!ffmpeg.ffmpeg) {
      return NextResponse.json(
        {
          error:
            "FFmpeg est indisponible sur cet hôte de rendu. Configurez VIDEO_FFMPEG_PATH (et VIDEO_FFPROBE_PATH) vers un binaire FFmpeg, ou lancez le worker scripts/video-worker.mts sur un hôte où FFmpeg est installé. Aucun rendu n'a été facturé.",
        },
        { status: 503 },
      );
    }

    // ORIGINE CANONIQUE (fix CodeQL request-forgery) : startRenderJob résout
    // GEN3IA_APP_ORIGIN en interne (allowlist serveur) — l'origine n'est pas
    // un paramètre d'appelant.
    const result = await startRenderJob({
      userId: guard.context.userId,
      projectId,
      derivedTargets,
    });
    return NextResponse.json(
      { ...result, imagesEnabled: isImageGenerationEnabled(), queueMode: qstashConfig() ? ("qstash" as const) : ("poll" as const) },
      { status: 202 },
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Rendu impossible" }, { status: errorStatus(error, 400) });
  }
}

/**
 * Liste les rendus du projet + CONTINUATION PAR SONDAGE (Task 1-a FIX 5b) :
 * si un job est en file ou orphelin (bail expiré), un tick borné (~55 s max,
 * checkpoint entre chaque segment) est exécuté DANS cette requête — le rendu
 * avance même sans QStash tant que le studio est ouvert. Le claim
 * transactionnel (bail) empêche deux polls concurrents de doubler un tick.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-render-list", rateLimit: { limit: 240, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;

    // Sweep best-effort des jobs orphelins de CE projet — throttlé (lot C4a,
    // voir sweepRenderJobsIfDue) : supprimé en mode QStash, 1 exécution max
    // par minute sinon.
    await sweepRenderJobsIfDue(projectId);

    let jobs = await listJobs(guard.context.userId, projectId);
    const pending = jobs.find((job) => {
      if (job.status === "queued") return true;
      if (job.status !== "processing") return false;
      const leaseActive = typeof job.leaseExpiresAt === "number" && job.leaseExpiresAt > Date.now();
      return !leaseActive;
    });
    if (pending) {
      // UN job par poll, budget borné — le poll reste responsive.
      // Lot C4b : la relecture post-tick n'arrive QUE si le tick a réellement
      // avancé (résultat non nul) — un job détenu par un worker vivant (bail
      // actif, cas nominal QStash) ne déclenche plus un second listJobs.
      const ticked = await maybeAdvancePendingJob(pending.id, { timeBudgetMs: POLL_ADVANCE_BUDGET_MS }).catch(() => null);
      if (ticked) jobs = await listJobs(guard.context.userId, projectId);
    }

    // URLs de lecture présignées pour les rendus terminés (master + exports).
    const { createVideoPlaybackUrl } = await import("@/lib/video/storage");
    const jobsWithUrls = await Promise.all(
      jobs.map(async (job) => {
        const liveProgress = await getJobProgress(job.id);
        return {
        ...job,
        ...(liveProgress
          ? {
              progress: liveProgress.progress,
              status: liveProgress.status as typeof job.status,
              stage: (liveProgress.stage as typeof job.stage) ?? job.stage,
            }
          : {}),
        output: job.output
          ? { ...job.output, playbackUrl: await createVideoPlaybackUrl(guard.context.userId, job.output.r2Key, 900).catch(() => null) }
          : undefined,
        exports: await Promise.all(
          job.exports.map(async (e) => e.status === "done"
            ? { ...e, playbackUrl: await createVideoPlaybackUrl(guard.context.userId, e.r2Key, 900).catch(() => null) }
            : e),
        ),
        };
      }),
    );
    return NextResponse.json({
      jobs: jobsWithUrls,
      queueMode: qstashConfig() ? ("qstash" as const) : ("poll" as const),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Liste impossible" }, { status: errorStatus(error, 500) });
  }
}

/** Actions sur un job : pause / reprise / annulation. */
export async function PATCH(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-render-action", rateLimit: { limit: 30, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    await params;
    const { jobId, action } = (await request.json()) as { jobId?: string; action?: string };
    if (!jobId || !action) throw new Error("jobId et action requis.");
    // ORIGINE CANONIQUE (fix CodeQL request-forgery) : resumeJob republie le
    // tick vers l'origine canonique résolue côté serveur (jamais la requête).
    if (action === "pause") await pauseJob(guard.context.userId, jobId);
    else if (action === "resume") await resumeJob(guard.context.userId, jobId);
    else if (action === "cancel") await cancelJob(guard.context.userId, jobId);
    else throw new Error(`Action inconnue : ${action}`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Action impossible" }, { status: errorStatus(error, 400) });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { RenderRequestSchema } from "@/lib/video/security";
import { startRenderJob, listJobs, pauseJob, resumeJob, cancelJob, sweepStaleRenderJobs, maybeAdvancePendingJob, POLL_ADVANCE_BUDGET_MS } from "@/lib/video/render-queue";
import { checkFfmpegAvailable } from "@/lib/video/ffmpeg";
import { qstashConfig } from "@/lib/queue/qstash";
import { isImageGenerationEnabled } from "@/lib/ai/image-generation";

export const runtime = "nodejs";
export const maxDuration = 60;

type Params = { params: Promise<{ projectId: string }> };

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

    const origin = process.env.GEN3IA_APP_ORIGIN?.trim() || request.nextUrl.origin;
    const result = await startRenderJob({
      userId: guard.context.userId,
      projectId,
      derivedTargets,
      origin,
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
    const origin = process.env.GEN3IA_APP_ORIGIN?.trim() || request.nextUrl.origin;

    // Sweep best-effort : les jobs orphelins de CE projet repassent en file
    // (ou échouent proprement) avant la reprise par sondage.
    await sweepStaleRenderJobs(origin).catch(() => undefined);

    let jobs = await listJobs(guard.context.userId, projectId);
    const pending = jobs.find((job) => {
      if (job.status === "queued") return true;
      if (job.status !== "processing") return false;
      const leaseActive = typeof job.leaseExpiresAt === "number" && job.leaseExpiresAt > Date.now();
      return !leaseActive;
    });
    if (pending) {
      // UN job par poll, budget borné — le poll reste responsive.
      await maybeAdvancePendingJob(pending.id, { origin, timeBudgetMs: POLL_ADVANCE_BUDGET_MS }).catch(() => undefined);
      jobs = await listJobs(guard.context.userId, projectId);
    }

    // URLs de lecture présignées pour les rendus terminés (master + exports).
    const { createVideoPlaybackUrl } = await import("@/lib/video/storage");
    const jobsWithUrls = await Promise.all(
      jobs.map(async (job) => ({
        ...job,
        output: job.output
          ? { ...job.output, playbackUrl: await createVideoPlaybackUrl(guard.context.userId, job.output.r2Key, 900).catch(() => null) }
          : undefined,
        exports: await Promise.all(
          job.exports.map(async (e) => e.status === "done"
            ? { ...e, playbackUrl: await createVideoPlaybackUrl(guard.context.userId, e.r2Key, 900).catch(() => null) }
            : e),
        ),
      })),
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
    const origin = process.env.GEN3IA_APP_ORIGIN?.trim() || request.nextUrl.origin;
    if (action === "pause") await pauseJob(guard.context.userId, jobId);
    else if (action === "resume") await resumeJob(guard.context.userId, jobId, origin);
    else if (action === "cancel") await cancelJob(guard.context.userId, jobId);
    else throw new Error(`Action inconnue : ${action}`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Action impossible" }, { status: errorStatus(error, 400) });
  }
}

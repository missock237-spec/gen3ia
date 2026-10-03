import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { RenderRequestSchema } from "@/lib/video/security";
import { startRenderJob, listJobs, pauseJob, resumeJob, cancelJob } from "@/lib/video/render-queue";
import { isImageGenerationEnabled } from "@/lib/ai/image-generation";

export const runtime = "nodejs";
export const maxDuration = 60;

type Params = { params: Promise<{ projectId: string }> };

/** Démarre un rendu (file QStash, checkpoints, reprise, budget réservé). */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-render-start", rateLimit: { limit: 8, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const { derivedTargets } = RenderRequestSchema.parse(await request.json().catch(() => ({})));
    const origin = process.env.GEN3IA_APP_ORIGIN?.trim() || request.nextUrl.origin;
    const result = await startRenderJob({
      userId: guard.context.userId,
      projectId,
      derivedTargets,
      origin,
    });
    return NextResponse.json({ ...result, imagesEnabled: isImageGenerationEnabled() }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Rendu impossible" }, { status: errorStatus(error, 400) });
  }
}

export async function GET(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-render-list", rateLimit: { limit: 240, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const jobs = await listJobs(guard.context.userId, projectId);
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
    return NextResponse.json({ jobs: jobsWithUrls });
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

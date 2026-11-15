import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { getOwnedJobOrThrow } from "@/lib/video/render-queue";
import { createVideoPlaybackUrl } from "@/lib/video/storage";

export const runtime = "nodejs";

type Params = { params: Promise<{ projectId: string; jobId: string }> };

/** Statut d'un rendu : progression, étape, checkpoints, QC, exports. */
export async function GET(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-render-status", rateLimit: { limit: 240, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId, jobId } = await params;
    const job = await getOwnedJobOrThrow(guard.context.userId, jobId);
    if (job.projectId !== projectId) return NextResponse.json({ error: "Rendu introuvable." }, { status: 404 });
    // URLs de lecture présignées (master + exports livrés).
    const output = job.output ? { ...job.output, playbackUrl: await createVideoPlaybackUrl(guard.context.userId, job.output.r2Key, 900).catch(() => null) } : null;
    const exports = await Promise.all(
      job.exports
        .filter((e) => e.status === "done")
        .map(async (e) => ({ ...e, playbackUrl: await createVideoPlaybackUrl(guard.context.userId, e.r2Key, 900).catch(() => null) })),
    );
    return NextResponse.json({ job: { ...job, output, exports } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Statut indisponible" }, { status: errorStatus(error, 404) });
  }
}

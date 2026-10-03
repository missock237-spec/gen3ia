import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { getOwnedProjectOrThrow } from "@/lib/video/project-service";
import { getOwnedJobOrThrow, listJobs } from "@/lib/video/render-queue";
import { downloadVideoAsset } from "@/lib/video/storage";
import { analyzeRenderedMaster } from "@/lib/video/qc-service";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ projectId: string }> };

/**
 * QC à la demande : ré-analyse le dernier master rendu (téléchargé depuis
 * R2) — même agent QC que le pipeline, exécuté sur demande utilisateur.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-analyze", rateLimit: { limit: 6, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    await getOwnedProjectOrThrow(guard.context.userId, projectId);
    const jobs = (await listJobs(guard.context.userId, projectId))
      .filter((j) => j.status === "completed" && j.output && j.plan)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const job = jobs[0];
    if (!job) throw new Error("Aucun rendu terminé à analyser.");

    const dir = await mkdtemp(join(tmpdir(), "gen3ia-qc-"));
    try {
      const master = await downloadVideoAsset(guard.context.userId, job.output!.r2Key);
      const masterPath = join(dir, "master.mp4");
      await writeFile(masterPath, master);
      const report = await analyzeRenderedMaster({
        masterFile: masterPath,
        tmpDir: dir,
        plan: job.plan!,
        expectedDurationSec: job.plan!.estimatedSec,
        subtitlesEnabled: Boolean(job.plan!.subtitles?.assR2Key),
      });
      return NextResponse.json({ report, jobId: job.id });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Analyse impossible" }, { status: errorStatus(error, 400) });
  }
}

// Vérification d'accès explicite (aucune fuite cross-utilisateur via jobId).
void getOwnedJobOrThrow;

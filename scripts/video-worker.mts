/**
 * GEN3IA VIDEO AGENT — worker de rendu standalone (Task 79).
 *
 * Pour un hôte avec FFmpeg installé (auto-hébergé / conteneur worker) :
 *
 *   FIREBASE_PROJECT_ID=… FIREBASE_CLIENT_EMAIL=… FIREBASE_PRIVATE_KEY=… \
 *     npx tsx scripts/video-worker.mts
 *
 * Boucle : réclame le prochain job `queued` (claim atomique Firestore) et
 * le fait avancer étape par étape via la MÊME machine que le receiver
 * QStash (advanceJob) — checkpoints, reprise, annulation identiques.
 * QStash absent ? Le worker local est le chemin de rendu de secours.
 */

import { claimNextQueuedJob, getJob, advanceJob } from "@/lib/video/render-queue";
import { cleanupPassFiles } from "@/lib/video/long-video-service";

const POLL_INTERVAL_MS = Number(process.env.VIDEO_WORKER_POLL_MS ?? 5_000);
const ORIGIN = process.env.GEN3IA_APP_ORIGIN?.trim() || "http://localhost:3000";

async function tick(): Promise<boolean> {
  const claimed = await claimNextQueuedJob();
  if (!claimed) return false;
  console.log(`[video-worker] job ${claimed.id.slice(0, 8)} (projet ${claimed.projectId.slice(0, 8)}) — traitement`);
  try {
    const result = await advanceJob(claimed.id, ORIGIN);
    console.log(`[video-worker] ${result.stage ?? "-"} → ${result.status} : ${result.message}`);
    if (result.status === "completed") {
      const job = await getJob(claimed.id);
      if (job?.tmpDir) await cleanupPassFiles(job.tmpDir);
    }
  } catch (error) {
    console.error(`[video-worker] incident job ${claimed.id.slice(0, 8)} :`, error);
  }
  return true;
}

async function main(): Promise<void> {
  console.log(`[video-worker] démarré (poll ${POLL_INTERVAL_MS} ms, origin ${ORIGIN})`);
  while (true) {
    const worked = await tick();
    if (!worked) await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((error) => {
  console.error("[video-worker] fatal :", error);
  process.exit(1);
});

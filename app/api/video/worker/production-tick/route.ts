import { NextRequest, NextResponse } from "next/server";

import { tickQueueConfigured, verifyTickRequest, enqueueVideoProductionTick } from "@/lib/queue/tick-queue";
import { advanceProductionJob, sweepStaleProductionJobs } from "@/lib/video/production-queue";
import { logSystem } from "@/lib/video/project-service";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Worker de la production vidéo autopilote (receiver de la file de ticks
 * R2 — ex-QStash, même vérification que le tick de rendu).
 *
 * Une délivrance POST ici un POST signé { jobId } : chaque délivrance exécute
 * UNE étape (ou un lot borné de scènes) puis se ré-enfile jusqu'à complétion
 * — création → plan → scénario → visuels → voix → rendu → livraison.
 *
 * APPELANT : la délivrance immédiate est un fire-and-forget gracié ; seul le
 * PUMP attend la réponse complète (2xx = ticket consommé, 5xx = réessai).
 */

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: NextRequest) {
  if (!tickQueueConfigured()) {
    return NextResponse.json({ error: "Queue non configurée" }, { status: 503 });
  }
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Corps trop volumineux" }, { status: 413 });
  }
  if (!verifyTickRequest(rawBody, request.headers.get("authorization"), request.headers.get("x-gen3a-tick"))) {
    return NextResponse.json({ error: "Signature de tick invalide" }, { status: 401 });
  }

  let jobId: string | undefined;
  try {
    const parsed = JSON.parse(rawBody) as { jobId?: string };
    jobId = parsed.jobId;
  } catch {
    return NextResponse.json({ error: "Corps invalide" }, { status: 400 });
  }
  if (!jobId) return NextResponse.json({ error: "jobId requis" }, { status: 400 });

  // ORIGINE CANONIQUE (fix CodeQL request-forgery) : plus aucune origine
  // dérivée de la requête — advanceProductionJob/enqueueVideoProductionTick/
  // sweepStaleProductionJobs résolvent GEN3IA_APP_ORIGIN en interne.
  // Sweep des jobs orphelins (bail expiré) — best-effort, jamais bloquant.
  await sweepStaleProductionJobs().catch(() => undefined);
  try {
    const result = await advanceProductionJob(jobId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tick de production échoué";
    await logSystem("", `Worker production : incident tick ${jobId.slice(0, 8)} — ${message}`).catch(() => undefined);
    // Ré-enfile avec délai (le job restera récupérable par le sweeper / pump).
    await enqueueVideoProductionTick(jobId, 60).catch(() => undefined);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

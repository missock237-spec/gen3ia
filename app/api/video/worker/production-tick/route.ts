import { NextRequest, NextResponse } from "next/server";
import { qstashConfig, verifyUpstashSignature } from "@/lib/queue/qstash";
import { advanceProductionJob, publishProductionTick, sweepStaleProductionJobs } from "@/lib/video/production-queue";
import { logSystem } from "@/lib/video/project-service";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Worker de la production vidéo autopilote (receiver QStash signé — même
 * vérification que le tick de rendu, Task 1-a FIX 7).
 *
 * QStash délivre un POST signé { jobId } : chaque délivrance exécute UNE
 * étape (ou un lot borné de scènes) puis se ré-enfile jusqu'à complétion —
 * création → plan → scénario → visuels → voix → rendu → livraison.
 */

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: NextRequest) {
  const config = qstashConfig();
  if (!config) {
    return NextResponse.json({ error: "Queue non configurée" }, { status: 503 });
  }
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Corps trop volumineux" }, { status: 413 });
  }
  if (!verifyUpstashSignature(config, rawBody, request.headers.get("upstash-signature"))) {
    return NextResponse.json({ error: "Signature QStash invalide" }, { status: 401 });
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
  // dérivée de la requête — advanceProductionJob/publishProductionTick/
  // sweepStaleProductionJobs résolvent GEN3IA_APP_ORIGIN en interne.
  // Sweep des jobs orphelins (bail expiré) — best-effort, jamais bloquant.
  await sweepStaleProductionJobs().catch(() => undefined);
  try {
    const result = await advanceProductionJob(jobId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tick de production échoué";
    await logSystem("", `Worker production : incident tick ${jobId.slice(0, 8)} — ${message}`).catch(() => undefined);
    // Ré-enfile avec délai (le job restera récupérable par le sweeper / sondage).
    await publishProductionTick(jobId, 60).catch(() => undefined);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

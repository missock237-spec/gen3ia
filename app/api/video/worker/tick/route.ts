import { NextRequest, NextResponse } from "next/server";

import { tickQueueConfigured, verifyTickRequest, enqueueVideoRenderTick } from "@/lib/queue/tick-queue";
import { advanceJob, sweepStaleRenderJobs } from "@/lib/video/render-queue";
import { logSystem } from "@/lib/video/project-service";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Worker du rendu vidéo (receiver de la file de ticks R2 — ex-QStash).
 *
 * Une délivrance POST ici un POST signé { jobId } : chaque délivrance fait
 * avancer le job d'UNE étape (ou d'un lot borné de segments) puis se
 * ré-enfile s'il reste du travail. Le rendu survit donc aux fermetures
 * d'onglets, aux échéances serverless et aux redémarrages — reprise par
 * CHECKPOINTS (segments terminés, passes d'assemblage), jamais de re-rendu
 * complet. Contrairement à l'ancienne file externe (1 000 messages/jour),
 * le stockage R2 n'a AUCUN plafond journalier : un rendu de 40 segments
 * n'est plus bloqué en cours de montage.
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
  // dérivée de la requête — advanceJob/enqueueVideoRenderTick/
  // sweepStaleRenderJobs résolvent GEN3IA_APP_ORIGIN en interne (allowlist).
  // Sweep des jobs orphelins (bail expiré) — best-effort, jamais bloquant.
  await sweepStaleRenderJobs().catch(() => undefined);
  try {
    const result = await advanceJob(jobId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tick échoué";
    await logSystem("", `Worker : incident tick ${jobId.slice(0, 8)} — ${message}`).catch(() => undefined);
    // Ré-enfile avec délai (le job restera récupérable par les tentatives
    // internes et le pump).
    await enqueueVideoRenderTick(jobId, 60).catch(() => undefined);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

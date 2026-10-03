import { NextRequest, NextResponse } from "next/server";
import { qstashConfig, verifyUpstashSignature } from "@/lib/queue/qstash";
import { advanceJob, publishVideoTick } from "@/lib/video/render-queue";
import { logSystem } from "@/lib/video/project-service";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Worker du rendu vidéo (receiver QStash signé).
 *
 * QStash délivre un POST signé { jobId } : chaque délivrance fait avancer
 * le job d'UNE étape (ou d'un lot borné de segments) puis se ré-enfile si
 * il reste du travail. Le rendu survit donc aux fermetures d'onglets, aux
 * échéances serverless et aux redémarrages — reprise par CHECKPOINTS
 * (segments terminés, passes d'assemblage), jamais de re-rendu complet.
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

  const origin = process.env.GEN3IA_APP_ORIGIN?.trim() || request.nextUrl.origin;
  try {
    const result = await advanceJob(jobId, origin);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tick échoué";
    await logSystem("", `Worker : incident tick ${jobId.slice(0, 8)} — ${message}`).catch(() => undefined);
    // Ré-enfile avec délai (le job restera récupérable par les tentatives internes).
    await publishVideoTick(origin, jobId, 60).catch(() => undefined);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

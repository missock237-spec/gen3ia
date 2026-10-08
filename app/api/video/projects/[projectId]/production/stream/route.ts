import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { getOwnedProjectOrThrow } from "@/lib/video/project-service";
import {
  buildProductionProgressEvent,
  getProductionJob,
  listProductionJobs,
  maybeAdvancePendingProductionJob,
  sweepStaleProductionJobs,
  type VideoProductionJob,
} from "@/lib/video/production-queue";
import { qstashConfig } from "@/lib/queue/qstash";
import { cacheGet, cacheSet } from "@/lib/cache/redis";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

// ────────────────────────────────────────────────────────────────────────────
// Task 106-c — flux SSE de progression de la production autopilote.
//
// Remplace le polling 5 s côté client (chat/studio) : le client ouvre
// GET .../production/stream et reçoit des événements `data: {...}\n\n` :
//   { type: "progress", jobId, projectId, stage, status, progress,
//     sceneCursor, warnings?, updatedAt }  — toutes les ~2,5 s ;
//   { type: "done", jobId, renderJobId? }                 — fin propre ;
//   { type: "failed", jobId, error }                      — échec/annulation ;
//   { type: "timeout" }                                    — borne de 280 s ;
//   { type: "error", message }                             — incident.
//
// CRITIQUE (miroir de la route GET .../production) : en mode sondage, la
// requête EST le moteur de continuation — la boucle appelle
// maybeAdvancePendingProductionJob avec un budget BORNÉ (20 s : le flux doit
// garder le temps d'écrire ses événements), sans quoi la production
// STAGNERAIT quand le client utilise le stream. Le claim transactionnel
// (bail) garantit qu'un tick QStash concurrent n'est jamais doublé.
//
// Protections IDENTIQUES à la route GET : protectRoute (auth + rate-limit) et
// cloisonnement propriétaire strict (getOwnedProjectOrThrow ; ?jobId= est
// vérifié userId + projectId — un user ne peut JAMAIS streamer la production
// d'un autre).
// ────────────────────────────────────────────────────────────────────────────

/** Cadence d'émission des événements « progress ». */
const STREAM_INTERVAL_MS = 2_500;
/** Borne haute du flux (marge sur maxDuration = 300 s). */
const STREAM_TIMEOUT_MS = 280_000;
/**
 * Budget de continuation DANS la boucle (borné ~20-25 s, contre 55 s pour le
 * GET classique) : chaque itération peut faire avancer la production d'un
 * lot de scènes, mais doit laisser du temps à l'écriture d'événements.
 */
const STREAM_ADVANCE_BUDGET_MS = 20_000;

// Sweep throttlé des jobs orphelins (même pattern que la route GET — lot
// C4a : supprimé en mode QStash, 1 exécution max/minute/projet sinon).
const SWEEP_THROTTLE_MS = 60_000;
const localSweepAt = new Map<string, number>();

async function sweepProductionJobsIfDue(projectId: string): Promise<void> {
  if (qstashConfig()) return;
  const throttleKey = `sweep:production-stream:${projectId}`;
  const now = Date.now();
  const localAt = localSweepAt.get(throttleKey);
  if (typeof localAt === "number" && now - localAt < SWEEP_THROTTLE_MS) return;
  const sharedAt = await cacheGet<number>(throttleKey);
  if (typeof sharedAt === "number" && now - sharedAt < SWEEP_THROTTLE_MS) {
    localSweepAt.set(throttleKey, sharedAt);
    return;
  }
  localSweepAt.set(throttleKey, now);
  await cacheSet(throttleKey, now, Math.ceil(SWEEP_THROTTLE_MS / 1000));
  await sweepStaleProductionJobs().catch(() => undefined);
}

/** Sleep interruptible : résolu à l'échéance OU à l'abort du client. */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish);
  });
}

/** true si le job a atteint un état terminal (fin propre du flux). */
function isTerminalStatus(job: VideoProductionJob): boolean {
  return job.status === "completed" || job.status === "failed" || job.status === "cancelled";
}

/**
 * Flux SSE de progression d'une production. ?jobId= optionnel — sinon le
 * dernier job du projet. La boucle fait avancer la production (même moteur
 * que le GET) puis émet l'état ; fin propre sur terminaison, timeout ou
 * déconnexion du client (request.signal).
 */
export async function GET(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-production-stream", rateLimit: { limit: 30, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    // Cloisonnement propriétaire strict (anti-énumération) — identique au GET.
    await getOwnedProjectOrThrow(guard.context.userId, projectId);

    // Résolution du job suivi : ?jobId= explicite (vérifié propriétaire) ou
    // dernier job du projet.
    const requestedJobId = new URL(request.url).searchParams.get("jobId")?.trim();
    let job: VideoProductionJob | null;
    if (requestedJobId) {
      const candidate = await getProductionJob(requestedJobId);
      if (!candidate || candidate.userId !== guard.context.userId || candidate.projectId !== projectId) {
        return NextResponse.json({ error: "Job de production introuvable." }, { status: 404 });
      }
      job = candidate;
    } else {
      job = (await listProductionJobs(guard.context.userId, projectId))[0] ?? null;
    }
    if (!job) {
      return NextResponse.json({ error: "Aucune production à suivre pour ce projet." }, { status: 404 });
    }
    const jobId = job.id;

    // Sweep best-effort des orphelins (throttlé — voir sweepProductionJobsIfDue).
    await sweepProductionJobsIfDue(projectId);

    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: unknown): void => {
          if (closed) return;
          try {
            // Format SSE : un événement = `data: {json}\n\n`.
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            // Client déconnecté : on cesse d'émettre ; la production
            // continue par ses propres continuations (QStash/sondage/sweep).
            closed = true;
          }
        };

        const onAbort = (): void => {
          closed = true;
        };
        request.signal.addEventListener("abort", onAbort);

        const startedAt = Date.now();
        try {
          while (!closed) {
            if (request.signal.aborted) break;
            if (Date.now() - startedAt >= STREAM_TIMEOUT_MS) {
              send({ type: "timeout", jobId });
              break;
            }

            // MOTEUR DE CONTINUATION (identique au GET production) : un tick
            // borné par itération — la production avance même sans QStash
            // tant que le client écoute le flux.
            await maybeAdvancePendingProductionJob(jobId, { timeBudgetMs: STREAM_ADVANCE_BUDGET_MS }).catch(() => null);

            const current = await getProductionJob(jobId);
            if (!current) {
              send({ type: "error", jobId, message: "Job de production introuvable (supprimé ?)." });
              break;
            }

            send(buildProductionProgressEvent(current));

            if (isTerminalStatus(current)) {
              if (current.status === "completed") {
                send({ type: "done", jobId, ...(current.renderJobId ? { renderJobId: current.renderJobId } : {}), progress: 1 });
              } else {
                send({
                  type: "failed",
                  jobId,
                  error: current.error ?? (current.status === "cancelled" ? "Production annulée." : "Production échouée."),
                });
              }
              break;
            }

            await sleepAbortable(STREAM_INTERVAL_MS, request.signal);
          }
        } finally {
          request.signal.removeEventListener("abort", onAbort);
          closed = true;
          try {
            controller.close();
          } catch {
            /* déjà fermé */
          }
        }
      },
      cancel() {
        // Déconnexion client : stoppe la boucle ; aucun état serveur à
        // restaurer (le moteur de production est indépendant du flux).
        closed = true;
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    // Erreurs d'authentification/validation AVANT le démarrage du flux :
    // réponse JSON classique, traitée comme la route non-stream.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Flux de production indisponible" },
      { status: errorStatus(error, 400) },
    );
  }
}

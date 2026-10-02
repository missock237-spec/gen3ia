import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { getMissionRun } from "@/lib/queue/mission-queue";
import { errorStatus } from "@/lib/security/http-errors";

/**
 * Flux SSE de progression d'une mission en file (recommandation A).
 *
 * CONTRAT CLIENT : `EventSource` natif (le cookie de session est envoyé
 * automatiquement same-origin ; le chemin Bearer reste valable via
 * fetch-streaming). Événements :
 *  - `progress` : { runId, status, pendingCount, timeline, updatedAtMs } à
 *    chaque changement significatif (statut OU horodatage) ;
 *  - `final`   : { runId, status, lastError? } quand la mission est terminée
 *    (completed / failed / cancelled / paused-utilisateur) — le flux se ferme ;
 *  - fenêtre de flux bornée (~50 s) : le flux se ferme après un dernier
 *    `progress` et EventSource se RECONNECTE tout seul — la mission continue
 *    de vivre dans la file, jamais liée à la connexion du spectateur.
 *
 * Le flux lit le document de file (~2 s) : aucune connexion aux moteurs LLM,
 * aucun coût de génération — c'est un simple miroir de statut.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const POLL_MS = 2_000;
const HEARTBEAT_MS = 15_000;
const STREAM_WINDOW_MS = 50_000;

interface RouteContext { params: Promise<{ runId: string }> }

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { runId } = await params;
  if (!/^[0-9a-f-]{8,64}$/i.test(runId)) {
    return NextResponse.json({ error: "runId invalide" }, { status: 400 });
  }
  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Authentification requise" },
      { status: errorStatus(error, 401) },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          try { controller.close(); } catch { /* déjà fermé */ }
        }
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const heartbeat = () => {
        if (closed) return;
        controller.enqueue(encoder.encode(`: ping\n\n`));
      };

      const startedAt = Date.now();
      let lastSignature = "";
      let lastHeartbeat = Date.now();

      try {
        while (!closed && Date.now() - startedAt < STREAM_WINDOW_MS) {
          if (request.signal.aborted) { close(); return; }
          const record = await getMissionRun(user.uid, runId).catch(() => null);
          if (!record) {
            send("final", { runId, status: "not_found" });
            close();
            return;
          }
          const signature = `${record.status}:${record.updatedAtMs}:${record.pendingCount}`;
          if (signature !== lastSignature) {
            lastSignature = signature;
            send("progress", {
              runId: record.runId,
              status: record.status,
              pendingCount: record.pendingCount,
              attempts: record.attempts,
              timeline: record.timeline,
              updatedAtMs: record.updatedAtMs,
              ...(record.lastError ? { lastError: record.lastError } : {}),
            });
            if (TERMINAL_STATUSES.has(record.status) || record.status === "paused") {
              // paused = pause UTILISATEUR ici (la pause d'échéance de file
              // retombe sur « paused » quelques secondes seulement, entre
              // deux ticks — le flux du client qui la voit se reconnectera).
              send("final", { runId: record.runId, status: record.status, ...(record.lastError ? { lastError: record.lastError } : {}) });
              close();
              return;
            }
          }
          if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
            heartbeat();
            lastHeartbeat = Date.now();
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        // Fenêtre écoulée : dernier relevé + fermeture propre — EventSource
        // se reconnecte automatiquement et la boucle repart du statut actuel.
        const record = await getMissionRun(user.uid, runId).catch(() => null);
        if (record && !closed) {
          send("progress", {
            runId: record.runId,
            status: record.status,
            pendingCount: record.pendingCount,
            attempts: record.attempts,
            timeline: record.timeline,
            updatedAtMs: record.updatedAtMs,
            ...(record.lastError ? { lastError: record.lastError } : {}),
          });
        }
        close();
      } catch {
        close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

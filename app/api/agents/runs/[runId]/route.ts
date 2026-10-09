import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { getMissionRun } from "@/lib/queue/mission-queue";
import { errorStatus } from "@/lib/security/http-errors";

/**
 * Statut d'une mission en file (recommandation A — suivi par runId).
 *
 * Scopé PROPRIÉTAIRE : un document dont le userId ne correspond pas renvoie
 * 404 (anti-énumération, même convention que le reste de l'API). La réponse
 * expose le statut, la timeline compacte, le compteur d'étapes restantes et
 * les URLs de suivi — jamais le plan complet ni les payloads bruts.
 *
 * AUTO-RÉPARATION (Task 114) : si une mission en cours semble orpheline
 * (aucun tick depuis > 30 s ET lease absent/expiré), le polling du
 * propriétaire REPUBLIE le tick QStash (fail-soft). Le claim transactionnel
 * rend les doublons inoffensifs : aucune mission ne peut rester bloquée
 * parce qu'une livraison QStash a échoué (ex. rotation de clés de signature).
 */

export const dynamic = "force-dynamic";

interface RouteContext { params: Promise<{ runId: string }> }

/** Âge minimal (ms) d'inactivité avant qu'un sondage déclenche une republie. */
const STALE_REPUBLISH_MS = 30_000;

function republierSiOrpheline(record: { status: string; leaseUntilMs?: number; updatedAtMs: number; runId: string }): void {
  if (record.status !== "queued" && record.status !== "running") return;
  const now = Date.now();
  const leaseActif = typeof record.leaseUntilMs === "number" && record.leaseUntilMs > now;
  if (leaseActif) return;
  if (now - record.updatedAtMs < STALE_REPUBLISH_MS) return;
  void (async () => {
    try {
      const { publishMissionTick } = await import("@/lib/queue/qstash");
      await publishMissionTick(record.runId);
    } catch {
      // Fail-soft : le prochain sondage retentera ; le disjoncteur QStash
      // (origine non résolue) reste silencieux par design.
    }
  })();
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { runId } = await params;
  if (!/^[0-9a-f-]{8,64}$/i.test(runId)) {
    return NextResponse.json({ error: "runId invalide" }, { status: 400 });
  }
  try {
    const user = await requireUser(request);
    const record = await getMissionRun(user.uid, runId);
    if (!record) {
      return NextResponse.json({ error: "Mission introuvable" }, { status: 404 });
    }
    republierSiOrpheline(record);
    return NextResponse.json(
      {
        runId: record.runId,
        status: record.status,
        objective: record.objective,
        ...(record.projectId ? { projectId: record.projectId } : {}),
        attempts: record.attempts,
        pendingCount: record.pendingCount,
        timeline: record.timeline,
        ...(record.lastError ? { lastError: record.lastError } : {}),
        // Manifest des livrables réels (artefacts, fichiers) — renseigné à
        // la finalisation par le runtime/tick (exigence « mission livrée »).
        ...(Array.isArray(record.deliverables) && record.deliverables.length > 0 ? { deliverables: record.deliverables } : {}),
        createdAtMs: record.createdAtMs,
        updatedAtMs: record.updatedAtMs,
        ...(record.completedAtMs ? { completedAtMs: record.completedAtMs } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur de suivi" },
      { status: errorStatus(error, 500) },
    );
  }
}

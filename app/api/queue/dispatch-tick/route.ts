import { NextRequest, NextResponse } from "next/server";

import { safeError, executionLogger } from "@/lib/observability/logger";
import { dispatchSchedules } from "@/lib/agents/scheduler";
import {
  tickQueueConfigured,
  verifyTickRequest,
  enqueueDispatchTick,
} from "@/lib/queue/tick-queue";
import {
  scheduleNextDispatchTick,
  slotFor,
} from "@/lib/queue/dispatch-loop";
import { resolveJobOrigin } from "@/lib/queue/origin";

/**
 * Receiver de la boucle de dispatch planifié (Task 62 — priorité #5).
 *
 * Une délivrance POST ici un POST signé { slotEpoch } toutes les 5 minutes :
 * le tick exécute le dispatcher d'agents (claims transactionnels par slot —
 * idempotent, aucune double exécution possible même en redélivrance) puis
 * programme le tick du slot suivant. Le cron Vercel quotidien
 * (/api/cron/agent-schedules) sert de sentinelle de résurrection et le
 * pump opportuniste (polling client) réveille les tickets dus entre-temps.
 *
 * APPELANT : la délivrance immédiate de la file est un fire-and-forget
 * gracié ; seul le PUMP attend la réponse complète (2xx = ticket consommé,
 * 5xx = réessai backoff).
 *
 * SÉCURITÉ : authentification par SIGNATURE INTERNE (HMAC-SHA256 dérivé du
 * secret R2, temps constant, fraîcheur ±300 s — lib/queue/tick-queue.ts)
 * OU bearer CRON_SECRET. Un appel non signé est rejeté 401 AVANT tout
 * parsing métier. File non configurée → 503.
 *
 * RÉPONSES : 2xx = tick traité (le dispatch est idempotent, une redélivrance
 * est un no-op au niveau des claims) ; 5xx = échec du publish du successeur
 * UNIQUEMENT — le pump re-délivrera ce ticket et retentera la programmation
 * du successeur (la réservation transactionnelle est libérée avant le
 * retour).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Plafond défensif du corps attendu ({ slotEpoch } — jamais plus). */
const MAX_BODY_BYTES = 4_096;

export async function POST(request: NextRequest) {
  const log = executionLogger({ requestId: request.headers.get("x-request-id")?.trim() || "dispatch-tick" });
  const rawBody = await request.text();

  // 1) Configuration : la boucle exige la même config que la file missions.
  if (!tickQueueConfigured()) {
    return NextResponse.json({ error: "File d'attente non configurée." }, { status: 503 });
  }

  // 2) Signature interne (temps constant) ou bearer CRON_SECRET.
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Corps trop volumineux." }, { status: 413 });
  }
  if (!verifyTickRequest(rawBody, request.headers.get("authorization"), request.headers.get("x-gen3a-tick"))) {
    return NextResponse.json({ error: "Signature invalide." }, { status: 401 });
  }

  // 3) Slot visé par ce tick (par le publisher) — défensif si absent.
  let slotEpoch: number;
  try {
    const parsed = JSON.parse(rawBody || "{}") as { slotEpoch?: unknown };
    slotEpoch = typeof parsed.slotEpoch === "number" && Number.isFinite(parsed.slotEpoch)
      ? Math.floor(parsed.slotEpoch)
      : slotFor(Date.now());
  } catch {
    slotEpoch = slotFor(Date.now());
  }

  // ORIGINE CANONIQUE (fix CodeQL request-forgery) : lue côté serveur
  // uniquement — JAMAIS dérivée de la requête entrante (falsifiable).
  // scheduleNextDispatchTick attend une chaîne (paramètre qu'il ignore déjà) :
  // on lui passe l'origine canonique, ou chaîne vide si non résolue — dans ce
  // cas enqueueDispatchTick retournera un échec, la réservation sera libérée et
  // le cron quotidien (sentinelle) relancera la boucle.
  const canonicalOrigin = resolveJobOrigin();
  const origin = canonicalOrigin.ok ? canonicalOrigin.origin : "";

  try {
    // 4) Travail du slot : dispatcher les planifications dues (idempotent).
    const result = await dispatchSchedules(new Date());

    // 5) Exactement un successeur pour le slot suivant (contrôle transactionnel).
    const scheduled = await scheduleNextDispatchTick(origin, slotEpoch, Date.now(), (options) =>
      enqueueDispatchTick(options).then((published) =>
        published.ok ? { messageId: published.messageId } : null,
      ),
    );

    if (scheduled.kind === "publish-failed") {
      // Le travail a été fait ; le successeur manque : le ticket du slot
      // courant reste DÛ dans R2 — le pump / la sentinelle le re-délivrera et
      // la programmation du successeur sera retentée.
      log.error({ event: "dispatch.tick.publishFailed", slotEpoch, error: scheduled.error }, "Publish du successeur échoué");
      return NextResponse.json(
        { error: "Programmation du tick suivant impossible — rattrapage attendu.", slotEpoch },
        { status: 502 },
      );
    }

    log.info(
      { event: "dispatch.tick.completed", slotEpoch, scheduled: scheduled.kind, due: result.due, executed: result.executed.length },
      "Tick de dispatch traité",
    );
    return NextResponse.json({
      ok: true,
      slotEpoch,
      dispatched: result,
      successor: scheduled,
    });
  } catch (error) {
    log.error({ event: "dispatch.tick.failed", slotEpoch, error: safeError(error) }, "Tick de dispatch en échec");
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Tick de dispatch échoué" },
      { status: 500 },
    );
  }
}

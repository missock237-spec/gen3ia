import { NextRequest, NextResponse } from "next/server";

import { safeError, executionLogger } from "@/lib/observability/logger";
import { dispatchSchedules } from "@/lib/agents/scheduler";
import {
  qstashConfig,
  verifyUpstashSignature,
  publishDispatchTick,
} from "@/lib/queue/qstash";
import {
  scheduleNextDispatchTick,
  slotFor,
} from "@/lib/queue/dispatch-loop";
import { resolveJobOrigin } from "@/lib/queue/origin";

/**
 * Receiver de la boucle de dispatch planifié (Task 62 — priorité #5).
 *
 * QStash délivre ici un POST signé { slotEpoch } toutes les 5 minutes :
 * le tick exécute le dispatcher d'agents (claims transactionnels par slot
 * — idempotent, aucune double exécution possible même en redélivrance)
 * puis programme le tick du slot suivant. Le cron Vercel quotidien
 * (/api/cron/agent-schedules) sert de sentinelle de résurrection.
 *
 * SÉCURITÉ : authentification par SIGNATURE QStash (HMAC-SHA256 temps
 * constant, clé courante OU suivante) — identique à mission-tick. Un appel
 * non signé est rejeté 401 AVANT tout parsing métier. Configuration
 * absente → 503.
 *
 * RÉPONSES : 2xx = tick traité (le dispatch est idempotent, une
 * redélivrance est un no-op au niveau des claims) ; 5xx = échec du
 * publish du successeur UNIQUEMENT — la redélivrance QStash retentera
 * (la réservation transactionnelle est libérée avant le retour).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Plafond défensif du corps attendu ({ slotEpoch } — jamais plus). */
const MAX_BODY_BYTES = 4_096;

export async function POST(request: NextRequest) {
  const log = executionLogger({ requestId: request.headers.get("x-request-id")?.trim() || "dispatch-tick" });
  const rawBody = await request.text();

  // 1) Configuration : la boucle exige la même config que la file missions.
  const config = qstashConfig();
  if (!config) {
    return NextResponse.json({ error: "File d'attente non configurée." }, { status: 503 });
  }

  // 2) Signature QStash (temps constant, clé courante OU suivante).
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Corps trop volumineux." }, { status: 413 });
  }
  if (!verifyUpstashSignature(config, rawBody, request.headers.get("upstash-signature"))) {
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
  // cas publishDispatchTick retournera null, la réservation sera libérée et
  // le cron quotidien (sentinelle) relancera la boucle.
  const canonicalOrigin = resolveJobOrigin();
  const origin = canonicalOrigin.ok ? canonicalOrigin.origin : "";

  try {
    // 4) Travail du slot : dispatcher les planifications dues (idempotent).
    const result = await dispatchSchedules(new Date());

    // 5) Exactement un successeur pour le slot suivant (contrôle transactionnel).
    const scheduled = await scheduleNextDispatchTick(origin, slotEpoch, Date.now(), (options) =>
      // publishDispatchTick résout l'origine canonique en interne.
      publishDispatchTick(options),
    );

    if (scheduled.kind === "publish-failed") {
      // Le travail a été fait ; le successeur manque → 5xx : QStash
      // redélivre ce tick et retentera la programmation du successeur.
      log.error({ event: "dispatch.tick.publishFailed", slotEpoch, error: scheduled.error }, "Publish du successeur échoué");
      return NextResponse.json(
        { error: "Programmation du tick suivant impossible — redélivrance attendue.", slotEpoch },
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

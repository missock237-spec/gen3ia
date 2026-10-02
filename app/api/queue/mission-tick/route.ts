import { NextRequest, NextResponse } from "next/server";

import { safeError, executionLogger } from "@/lib/observability/logger";
import { recordExecutionMetrics } from "@/lib/observability/otel";
import { AgentRuntime } from "@/lib/agents/runtime/runner";
import { loadCheckpoint } from "@/lib/agents/runtime/checkpoint";
import { isExecutionPauseRequested } from "@/lib/agents/runtime/pause";
import type { RuntimePlan } from "@/lib/agents/runtime/types";
import {
  qstashConfig,
  verifyUpstashSignature,
  publishMissionTick,
} from "@/lib/queue/qstash";
import {
  claimMissionTick,
  persistMissionProgress,
  finalizeMissionRun,
  decideNextTick,
  NEXT_TICK_DELAY_SECONDS,
  type MissionQueueStatus,
} from "@/lib/queue/mission-queue";
import type { RuntimeExecutionState } from "@/lib/agents/runtime/types";

/**
 * Receiver de la file d'attente des missions (recommandation A de l'audit).
 *
 * QStash délivre ici un POST signé { runId } : chaque délivrance exécute une
 * TRANCHE bornée du plan (bail + échéance horloge) puis, si des étapes
 * restent, se RÉ-ENFILE. La mission survit donc à n'importe quelle fenêtre
 * serverless : le checkpoint runtime (étapes complétées + sorties) est écrit
 * par le runtime lui-même après chaque lot, et le tick suivant reprend
 * exactement là (getReadySteps saute le terminé).
 *
 * SÉCURITÉ : l'authentification est la SIGNATURE QStash (HMAC-SHA256 temps
 * constant, clé courante OU suivante pendant une rotation). Pas de session
 * utilisateur ici — un appel non signé est rejeté 401 AVANT tout parsing
 * métier. Configuration absente → 503 (la file n'est pas activée).
 *
 * RÉPONSES À QSTASH : 2xx = délivrance traitée (même « no-op » : bail déjà
 * détenu, mission terminée, document absent — arrêter les redélivrances est
 * le bon comportement) ; 5xx = échec TRANSITOIRE (QStash re-tentera, le bail
 * a expiré, le claim reprendra proprement). Un échec MÉTIER de mission
 * (étape failed) répond 2xx et fige la mission en « failed » : re-exécuter
 * automatiquement une mission facturée qui a échoué doublerait la facture
 * (même règle que les timeouts non-retryables, Task 45).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Budget horloge d'une tranche — laisse ≥ 10 s de marge sous les 60 s. */
const TICK_BUDGET_MS = 50_000;

/** Plafond défensif du corps attendu ({ runId } — jamais plus). */
const MAX_BODY_BYTES = 4_096;

/**
 * Correspondance statut runtime → statut de file. « pending » et « running »
 * ne sont pas des états de SORTIE de run() (invariant), mais le mapping les
 * traite comme une pause d'échéance : pendingStepsRemaining est vrai → la
 * décision ré-enfile → auto-réparation d'un état impossible au lieu d'une
 * mission fantôme.
 */
function queueStatusFromRuntime(status: RuntimeExecutionState["status"]): MissionQueueStatus {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
      return status;
    default:
      return "paused";
  }
}

export async function POST(request: NextRequest) {
  const log = executionLogger({ requestId: request.headers.get("x-request-id")?.trim() || "qstash-tick" });
  const rawBody = await request.text();

  // 1) Configuration : la file doit être activée pour accepter un tick.
  const config = qstashConfig();
  if (!config) {
    log.warn({ event: "queue.tick.unconfigured" }, "Tick reçu alors que la file n'est pas configurée");
    return NextResponse.json({ error: "Queue non configurée" }, { status: 503 });
  }

  // 2) Signature AVANT tout parsing métier (corps brut — le moindre
  //    réencodage invaliderait le HMAC).
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Corps trop volumineux" }, { status: 413 });
  }
  if (!verifyUpstashSignature(config, rawBody, request.headers.get("upstash-signature"))) {
    log.warn({ event: "queue.tick.unauthorized" }, "Signature QStash invalide");
    return NextResponse.json({ error: "Signature invalide" }, { status: 401 });
  }

  // 3) Charge utile minimale.
  let runId: string | undefined;
  try {
    const parsed = JSON.parse(rawBody) as { runId?: unknown };
    if (typeof parsed?.runId === "string" && /^[0-9a-f-]{8,64}$/i.test(parsed.runId)) {
      runId = parsed.runId;
    }
  } catch {
    runId = undefined;
  }
  if (!runId) {
    return NextResponse.json({ error: "Corps invalide (runId attendu)" }, { status: 400 });
  }

  // 4) Claim transactionnel : exactement UN worker par tranche.
  const claim = await claimMissionTick(runId);
  if (claim.kind !== "claimed") {
    log.info({ event: "queue.tick.skipped", runId, reason: claim.kind }, "Tick sans travail (no-op)");
    return NextResponse.json({ ok: true, skipped: claim.kind });
  }
  const record = claim.record;
  const { executionId } = record;

  try {
    // 5) Reprise : le checkpoint runtime prime (statuses + outputs réels) ;
    //    premier tick → plan du document de file.
    const checkpoint = await loadCheckpoint(executionId);
    const plan: RuntimePlan = checkpoint?.plan ?? record.plan!;
    const runtime = new AgentRuntime({
      userId: record.userId,
      ...(record.projectId ? { projectId: record.projectId } : {}),
      // Cloisonnement multi-tenant (Task 58) : relayé depuis le document de
      // file (l'orgId a été validé à l'enfilement par assertOrgAttach).
      ...(record.orgId ? { orgId: record.orgId } : {}),
      objective: record.objective || plan.objective,
      plan,
      ...(checkpoint && Object.keys(checkpoint.outputs ?? {}).length > 0
        ? { initialOutputs: checkpoint.outputs }
        : {}),
      batchDeadlineMs: Date.now() + TICK_BUDGET_MS,
    });

    let state;
    let failure: string | undefined;
    const tickStartedAt = Date.now();
    try {
      state = await runtime.run();
    } catch (error) {
      // Échec MÉTIER (étape failed, wallet vide, …) : terminer la mission,
      // NE PAS redélivrer (une re-exécution automatique = double facturation).
      failure = error instanceof Error ? error.message : String(error);
      log.error({ event: "queue.tick.failed", runId, executionId, error: safeError(error) }, "Mission en échec dans la tranche");
    }

    if (state) {
      // Métriques OTel (Task 59) : coût par organisation, chaque tranche
      // terminée incrémente les compteurs (no-op si export désactivé).
      recordExecutionMetrics({
        executionId,
        status: state.status,
        orgId: record.orgId,
        userId: record.userId,
        chargeMinor: state.billing?.totalChargeMinor ?? 0,
        providerCostEur: state.billing?.totalProviderCostEur ?? 0,
        inputTokens: state.billing?.llmInputTokens ?? 0,
        outputTokens: state.billing?.llmOutputTokens ?? 0,
        durationMs: Date.now() - tickStartedAt,
      });
      const steps = state.plan.steps;
      await persistMissionProgress(runId, steps);
      const pendingRemaining = steps.some((step) => step.status === "pending");
      const userPauseRequested = await isExecutionPauseRequested(executionId).catch(() => false);
      const queueStatus = queueStatusFromRuntime(state.status);
      const decision = decideNextTick({
        status: queueStatus,
        pendingStepsRemaining: pendingRemaining,
        userPauseRequested,
      });

      if (decision === "reenqueue") {
        // ORDRE CRITIQUE : libérer le statut/bail d'abord (document « paused »,
        // bail supprimé → claimable), PUIS ré-enfiler. Si le publish échoue
        // ensuite, QStash re-tentera la délivrance COURANTE : le claim
        // réussira (bail relâché) et le ré-enfilement sera rejoué — la
        // mission ne peut PAS rester bloquée. L'inverse (publish puis
        // finalisation) laisserait, sur un échec de publish, un document
        // « running » sans tick planifié : mission fantôme.
        await finalizeMissionRun(runId, "paused");
        const origin = process.env.GEN3IA_APP_ORIGIN?.trim() || request.nextUrl.origin;
        await publishMissionTick(origin, runId, { delaySeconds: NEXT_TICK_DELAY_SECONDS });
        log.info({ event: "queue.tick.reenqueued", runId, executionId, pendingRemaining }, "Tranche terminée — suite ré-enfilée");
        return NextResponse.json({ ok: true, runId, status: state.status, reenqueued: true });
      }

      if (queueStatus === "completed" || queueStatus === "failed" || queueStatus === "cancelled" || queueStatus === "paused") {
        await finalizeMissionRun(runId, queueStatus, { error: state.error });
      }
      log.info({ event: "queue.tick.finished", runId, executionId, status: state.status }, "Mission terminée dans la file");
      return NextResponse.json({ ok: true, runId, status: state.status });
    }

    // state === undefined → échec métier capté ci-dessus.
    await finalizeMissionRun(runId, "failed", { error: failure });
    return NextResponse.json({ ok: true, runId, status: "failed" });
  } catch (error) {
    // Échec INFRASTRUCTURE (Firestore, publish) : laisser QStash re-tenter —
    // le bail expire et le claim reprendra depuis le dernier checkpoint.
    log.error({ event: "queue.tick.infra", runId, executionId, error: safeError(error) }, "Échec infrastructure du tick — redélivrance attendue");
    return NextResponse.json({ error: "Erreur infrastructure" }, { status: 500 });
  }
}

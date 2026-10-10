import { NextRequest, NextResponse } from "next/server";

import { safeError, executionLogger } from "@/lib/observability/logger";
import { recordExecutionMetrics } from "@/lib/observability/otel";
import { AgentRuntime } from "@/lib/agents/runtime/runner";
import { buildPlanExecutionPolicy } from "@/lib/agents/runtime/plan-policy";
import { loadCheckpoint } from "@/lib/agents/runtime/checkpoint";
import { isExecutionPauseRequested } from "@/lib/agents/runtime/pause";
import type { RuntimePlan } from "@/lib/agents/runtime/types";
import {
  tickQueueConfigured,
  verifyTickRequest,
  enqueueMissionTick,
} from "@/lib/queue/tick-queue";
import {
  claimMissionTick,
  persistMissionProgress,
  finalizeMissionRun,
  decideNextTick,
  NEXT_TICK_DELAY_SECONDS,
  type MissionQueueStatus,
} from "@/lib/queue/mission-queue";
import type { RuntimeExecutionState } from "@/lib/agents/runtime/types";
import { applyOutcomeCredit, shouldCreditOutcomeFailure } from "@/lib/billing/outcome-credits";
import { captureMissionEscrow } from "@/lib/billing/mission-escrow";
import { settleAgentHireByExecution } from "@/lib/marketplace/hire";
import { recordFailureClusters } from "@/lib/agents/evolution";
import { extractDeliverables } from "@/lib/agents/deliverables";
import { deliverMissionToConversation } from "@/lib/agents/mission-delivery";

/**
 * Receiver de la file des missions (file de ticks R2 — ex-QStash).
 *
 * Une délivrance POST ici un POST signé { runId } : chaque délivrance
 * exécute une TRANCHE bornée du plan (bail + échéance horloge) puis, si des
 * étapes restent, se RÉ-ENFILE. La mission survit donc à n'importe quelle
 * fenêtre serverless : le checkpoint runtime (étapes complétées + sorties)
 * est écrit par le runtime lui-même après chaque lot, et le tick suivant
 * reprend exactement là (getReadySteps saute le terminé).
 *
 * APPELANT : la délivrance immédiate de la file (deliverTickNow) est un
 * fire-and-forget gracié — elle n'attend jamais cette réponse ; seul le PUMP
 * attend la réponse complète (2xx = ticket consommé, 5xx = réessai backoff).
 *
 * SÉCURITÉ : authentification par SIGNATURE INTERNE (HMAC-SHA256 dérivé du
 * secret R2, temps constant, fraîcheur ±300 s — lib/queue/tick-queue.ts)
 * OU bearer CRON_SECRET. Un appel non signé est rejeté 401 AVANT tout
 * parsing métier. File non configurée → 503 (contrat inchangé).
 *
 * RÉPONSES : 2xx = délivrance traitée (même « no-op » : bail déjà détenu,
 * mission terminée, document absent — arrêter les redélivrances est le bon
 * comportement) ; 5xx = échec TRANSITOIRE (le pump re-délivrera, le bail de
 * mission aura expiré, le claim reprendra proprement). Un échec MÉTIER de
 * mission (étape failed) répond 2xx et fige la mission en « failed » :
 * re-exécuter automatiquement une mission facturée qui a échoué doublerait
 * la facture (même règle que les timeouts non-retryables, Task 45).
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
  const log = executionLogger({ requestId: request.headers.get("x-request-id")?.trim() || "r2-tick" });
  const rawBody = await request.text();

  // 1) Configuration : la file doit être activée pour accepter un tick.
  if (!tickQueueConfigured()) {
    log.warn({ event: "queue.tick.unconfigured" }, "Tick reçu alors que la file n'est pas configurée");
    return NextResponse.json({ error: "Queue non configurée" }, { status: 503 });
  }

  // 2) Signature AVANT tout parsing métier (corps brut — le moindre
  //    réencodage invaliderait le HMAC).
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Corps trop volumineux" }, { status: 413 });
  }
  if (!verifyTickRequest(rawBody, request.headers.get("authorization"), request.headers.get("x-gen3a-tick"))) {
    log.warn({ event: "queue.tick.unauthorized" }, "Signature de tick invalide");
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
      // Contrat de résultat (concepts #1/#2) : relayé depuis le document de
      // file — la porte d'acceptation s'applique à chaque tick final.
      ...(record.outcomeContract ? { outcomeContract: record.outcomeContract } : {}),
      // POLICY DÉRIVÉE DU PLAN (Task 114) : les outils prévus par le
      // planificateur sont exactement ceux autorisés. SANS cela, la policy
      // par défaut (allowedTools: []) refuse toute étape tool/research
      // (« Tool not allowed ») et toute mission en file contenant un outil
      // échoue — le chemin synchrone construisait sa policy depuis le plan,
      // le chemin enfilé non.
      policy: buildPlanExecutionPolicy(plan),
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
        // bail supprimé → claimable), PUIS ré-enfiler. Si la délivrance
        // échoue ensuite, le ticket R2 reste DÛ : le pump (polling du client,
        // sentinelle cron) le re-délivrera — la mission ne peut PAS rester
        // bloquée. L'inverse (publish puis finalisation) laisserait, sur un
        // échec, un document « running » sans tick planifié : mission fantôme.
        await finalizeMissionRun(runId, "paused");
        // ORIGINE CANONIQUE (fix CodeQL request-forgery) : la route ne calcule
        // AUCUNE origine — enqueueMissionTick résout GEN3IA_APP_ORIGIN en
        // interne (allowlist serveur) et refuse de publier vers une cible non
        // autorisée (contrat « non configuré » : sondage en relais).
        await enqueueMissionTick(runId, { delaySeconds: NEXT_TICK_DELAY_SECONDS });
        log.info({ event: "queue.tick.reenqueued", runId, executionId, pendingRemaining }, "Tranche terminée — suite ré-enfilée");
        return NextResponse.json({ ok: true, runId, status: state.status, reenqueued: true });
      }

      if (queueStatus === "completed" || queueStatus === "failed" || queueStatus === "cancelled" || queueStatus === "paused") {
        // Manifest des livrables réels (artefacts, fichiers) extrait des
        // sorties d'étapes — exposé au client via /api/agents/runs/[runId].
        const deliverables = extractDeliverables(state.plan, state.outputs ?? {});
        await finalizeMissionRun(runId, queueStatus, {
          error: state.error,
          ...(deliverables.length > 0 ? { deliverables } : {}),
        });
        // ESCROW V2 (Task 114-a) : capture (réussite) / libération (échec,
        // annulation) du frais de résultat réservé au lancement — idempotent
        // et fail-soft (jamais bloquant pour la livraison ci-dessous).
        await captureMissionEscrow({ userId: record.userId, executionId, missionStatus: queueStatus, runId });
        // MARKETPLACE V2 (Task 114-c) : règlement de la location d'un agent
        // publié — capture du loyer + gain du propriétaire (réussite) ou
        // libération (échec/annulation). Fail-soft + idempotent (mapping
        // absent = sortie immédiate : les missions ordinaires ne paient rien
        // de plus) — un incident ne bloque JAMAIS la livraison ci-dessous.
        try {
          await settleAgentHireByExecution({ executionId, missionStatus: queueStatus });
        } catch (error) {
          console.error(
            "[mission-tick] règlement marketplace non appliqué (fail-soft) :",
            error instanceof Error ? error.message : error,
          );
        }
        // LIVRAISON À LA CONVERSATION (missions lancées depuis un chat) :
        // message final honnête + livrables + run réconcilié + notification.
        // La mission continue de vivre dans la file, jamais liée à l'onglet.
        if (record.conversationId) {
          await deliverMissionToConversation({
            userId: record.userId,
            conversationId: record.conversationId,
            state,
            ...(record.projectId ? { projectId: record.projectId } : {}),
            background: queueStatus === "completed" || queueStatus === "failed",
          }).catch(() => undefined);
        }
      }
      // Avoir automatique (concept #2) : mission sous contrat terminée en
      // échec (étapes en échec ou porte d'acceptation bloquante) → avoir
      // sur les frais réels (plafonné, idempotent, fail-soft).
      if (shouldCreditOutcomeFailure({ contractPresent: Boolean(record.outcomeContract), missionStatus: state.status })) {
        await applyOutcomeCredit({
          userId: record.userId,
          executionId,
          totalChargeMinor: state.billing?.totalChargeMinor ?? 0,
          missionStatus: state.status,
        });
      }
      // AUTO-ÉVOLUTION (concept #10) : les échecs alimentent les clusters de
      // leçons (fail-soft — jamais un blocage de la finalisation).
      if (state.status === "failed") {
        void recordFailureClusters(state, { ...(record.orgId ? { orgId: record.orgId } : {}) }).catch(() => undefined);
      }
      log.info({ event: "queue.tick.finished", runId, executionId, status: state.status }, "Mission terminée dans la file");
      return NextResponse.json({ ok: true, runId, status: state.status });
    }

    // state === undefined → échec métier capté ci-dessus.
    await finalizeMissionRun(runId, "failed", { error: failure });
    // ESCROW V2 : mission échue → le frais de résultat réservé est LIBÉRÉ
    // (fail-soft — un incident d'escrow ne change jamais la réponse du tick).
    await captureMissionEscrow({ userId: record.userId, executionId, missionStatus: "failed", runId }).catch(() => undefined);
    // MARKETPLACE V2 : mission échouée (throw runtime) → le loyer d'une
    // location éventuelle est LIBÉRÉ (fail-soft + idempotent, jamais bloquant).
    try {
      await settleAgentHireByExecution({ executionId, missionStatus: "failed" });
    } catch (error) {
      console.error(
        "[mission-tick] règlement marketplace non appliqué (fail-soft) :",
        error instanceof Error ? error.message : error,
      );
    }
    return NextResponse.json({ ok: true, runId, status: "failed" });
  } catch (error) {
    // Échec INFRASTRUCTURE (R2, délivrance) : répondre 5xx — le ticket R2
    // reste DÛ et le pump le re-délivrera ; le bail de mission expire et le
    // claim reprendra depuis le dernier checkpoint.
    log.error({ event: "queue.tick.infra", runId, executionId, error: safeError(error) }, "Échec infrastructure du tick — rattrapage pump attendu");
    return NextResponse.json({ error: "Erreur infrastructure" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { errorStatus } from "@/lib/security/http-errors";
import { z } from "zod";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import {
  AgentRuntime,
  RuntimePlanSchema,
} from "@/lib/agents/runtime";
import { executionLogger, safeError } from "@/lib/observability/logger";
import { recordExecutionMetrics } from "@/lib/observability/otel";
import { missionQueueConfigured, publishMissionTick } from "@/lib/queue/qstash";
import {
  createQueuedMission,
  markMissionEnqueueFailed,
} from "@/lib/queue/mission-queue";
import { assertOrgAttach } from "@/lib/tenants/resource-access";
import { OutcomeContractSchema } from "@/lib/agents/outcome-contract";
import { applyOutcomeCredit, shouldCreditOutcomeFailure } from "@/lib/billing/outcome-credits";
import { recordFailureClusters } from "@/lib/agents/evolution";

/**
 * Exécution d'un agent (API développeur + interne).
 *
 * Deux modes (recommandation A de l'audit de production — file d'attente des
 * tâches longues) :
 *
 *  - ASYNC (défaut quand la file QStash est configurée) : la mission est
 *    enregistrée (document `missionQueue`) et enfilée ; la réponse 202
 *    renvoie immédiatement `runId` + URLs de suivi (polling SSE/status).
 *    L'exécution se fait PAR TRANCHES dans /api/queue/mission-tick : une
 *    mission de plusieurs minutes survit aux fenêtres serverless (60 s),
 *    le client peut se déconnecter sans la tuer.
 *  - SYNC (fallback : file non configurée, ou `mode:"sync"` explicite) :
 *    exécution dans la requête comme avant — compatibilité totale avec les
 *    intégrations existantes. `maxDuration = 60` (au lieu du défaut
 *    plateforme 10 s, insuffisant pour un seul appel LLM outillé).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RunAgentSchema = z.object({
  objective: z.string().min(3).max(50_000),
  projectId: z.string().trim().min(1).max(128).optional(),
  /** Organisation propriétaire de la mission (Task 58) : l'appelant doit en être membre (validation AVANT toute écriture). */
  orgId: z.string().trim().min(1).max(128).optional(),
  plan: RuntimePlanSchema
    .omit({ executionId: true, objective: true })
    .optional(),
  /** Contrat de résultat (concepts #1/#2) : critères d'acceptation mesurables — la mission ne sera « completed » que s'ils sont vérifiés ; un échec déclenche un avoir automatique. */
  outcomeContract: OutcomeContractSchema.optional(),
  /** « auto » (défaut) : async si la file est configurée, sinon sync. */
  mode: z.enum(["auto", "async", "sync"]).optional(),
});

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  const log = executionLogger({ requestId });
  const startedAt = Date.now();

  try {
    const user = await requireUser(request);
    // Même classe de coût que /api/agents/[id]/run (12/5min) et
    // /api/v1/agents/[agentId]/run (30/5min) : l'entrée SDK/interne sans
    // limite pourrait enfiler des centaines de missions facturées.
    const limit = await enforceRateLimit(`mission-run:${user.uid}`, { limit: 30, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop d'executions rapprochees. Reessayez dans quelques minutes.", requestId },
        { status: 429, headers: { "x-request-id": requestId, "retry-after": String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))) } },
      );
    }
    const body = await request.json();
    const parsed = RunAgentSchema.safeParse(body);

    if (!parsed.success) {
      log.warn({ event: "agent.request.invalid", issues: parsed.error.issues }, "Invalid agent request");
      return NextResponse.json(
        { error: parsed.error.flatten(), requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }

    if (parsed.data.projectId) {
      const { getDeveloperProject } = await import("@/lib/developer/projects");
      if (!(await getDeveloperProject(user.uid, parsed.data.projectId))) {
        return NextResponse.json({ error: "Projet introuvable ou inaccessible", requestId }, { status: 403 });
      }
    }

    // Cloisonnement multi-tenant (Task 58) : l'orgId explicite n'est accepté
    // que si l'appelant est membre de l'organisation — garde AVANT toute
    // écriture (file ou exécution).
    if (parsed.data.orgId) {
      try {
        await assertOrgAttach(user.uid, parsed.data.orgId);
      } catch {
        return NextResponse.json({ error: "Organisation introuvable ou accès refusé", requestId }, { status: 403 });
      }
    }

    const executionId = randomUUID();
    const executionLog = log.child({ executionId, userId: user.uid, projectId: parsed.data.projectId, ...(parsed.data.orgId ? { orgId: parsed.data.orgId } : {}) });

    const plan = parsed.data.plan ?? {
      steps: [
        {
          id: "step_1",
          type: "llm",
          name: "Execute objective",
          description: parsed.data.objective,
          dependencies: [],
          status: "pending",
          input: {},
          skillIds: [],
          maxRetries: 2,
          timeoutMs: 120_000,
          sideEffect: false,
          requiresApproval: false,
        },
      ],
      maxConcurrency: 4,
      maxIterations: 10,
    };

    const runtimePlan = {
      ...plan,
      executionId,
      objective: parsed.data.objective,
    };

    // ---- File d'attente (mode async) --------------------------------
    const wantsAsync = parsed.data.mode === "async" || (parsed.data.mode !== "sync" && missionQueueConfigured());
    if (wantsAsync && missionQueueConfigured()) {
      const runId = randomUUID();
      try {
        await createQueuedMission({
          runId,
          executionId,
          userId: user.uid,
          objective: parsed.data.objective,
          ...(parsed.data.projectId ? { projectId: parsed.data.projectId } : {}),
          ...(parsed.data.orgId ? { orgId: parsed.data.orgId } : {}),
          ...(parsed.data.outcomeContract ? { outcomeContract: parsed.data.outcomeContract } : {}),
          plan: runtimePlan,
        });
        // ORIGINE CANONIQUE (fix CodeQL request-forgery) : publishMissionTick
        // résout GEN3IA_APP_ORIGIN en interne (allowlist serveur).
        const published = await publishMissionTick(runId);
        executionLog.info(
          { event: "execution.queued", runId, messageId: published?.messageId, steps: runtimePlan.steps.length },
          "Mission enfilée (exécution par tranches)",
        );
        return NextResponse.json(
          {
            runId,
            executionId,
            requestId,
            status: "queued",
            async: true,
            statusUrl: `/api/agents/runs/${runId}`,
            streamUrl: `/api/agents/runs/${runId}/stream`,
            pollSeconds: 2,
          },
          { status: 202, headers: { "x-request-id": requestId } },
        );
      } catch (error) {
        // Enfilement impossible (création ou publish) : échec HONNÊTE — la
        // mission est marquée failed dans la file (si le document existe) et
        // on ne bascule PAS silencieusement en sync : l'appelant a demandé
        // une exécution détachée (client mobile, mission > 60 s), un
        // démarrage synchrone serait coupé par la plateforme sans qu'il le
        // sache.
        if (parsed.data.mode === "async") {
          await markMissionEnqueueFailed(runId, error);
          executionLog.error({ event: "execution.enqueue.failed", runId, error: safeError(error) }, "Enfilement impossible");
          return NextResponse.json(
            {
              error: `File d'attente indisponible : ${error instanceof Error ? error.message : String(error)}`,
              requestId,
            },
            { status: 502, headers: { "x-request-id": requestId } },
          );
        }
        // mode auto : repli synchrone assumé (compatibilité intégrations).
        executionLog.warn({ event: "execution.enqueue.fallback", error: safeError(error) }, "File indisponible — repli synchrone");
      }
    }

    // ---- Exécution synchrone (fallback / explicite) ------------------
    executionLog.info(
      {
        event: "execution.started",
        stepCount: runtimePlan.steps.length,
        maxConcurrency: runtimePlan.maxConcurrency,
        maxIterations: runtimePlan.maxIterations,
      },
      "Agent execution started",
    );

    const runtime = new AgentRuntime({
      userId: user.uid,
      projectId: parsed.data.projectId,
      objective: parsed.data.objective,
      plan: runtimePlan,
      signal: request.signal,
      // Cloisonnement multi-tenant (Task 58) : mission d'organisation.
      orgId: parsed.data.orgId,
      // Contrat de résultat (concepts #1/#2) : la porte de sortie bloque
      // « completed » tant que les critères ne sont pas vérifiés.
      ...(parsed.data.outcomeContract ? { outcomeContract: parsed.data.outcomeContract } : {}),
    });

    const state = await runtime.run();
    const durationMs = Date.now() - startedAt;

    // Avoir automatique (concept #2) : mission sous contrat terminée en
    // échec → les frais réels sont remboursés (plafonnés, idempotent,
    // fail-soft). Fire-and-forget assumé : l'avoir ne bloque JAMAIS la
    // réponse de l'exécution.
    if (shouldCreditOutcomeFailure({ contractPresent: Boolean(parsed.data.outcomeContract), missionStatus: state.status })) {
      void applyOutcomeCredit({
        userId: user.uid,
        executionId,
        totalChargeMinor: state.billing?.totalChargeMinor ?? 0,
        missionStatus: state.status,
      }).catch(() => undefined);
    }

    // AUTO-ÉVOLUTION (concept #10) : échecs → clusters de leçons (fail-soft).
    if (state.status === "failed") {
      void recordFailureClusters(state, { ...(parsed.data.orgId ? { orgId: parsed.data.orgId } : {}) }).catch(() => undefined);
    }

    // Métriques OTel (Task 59) : coût par organisation (no-op si export désactivé).
    recordExecutionMetrics({
      executionId,
      status: state.status,
      orgId: parsed.data.orgId,
      userId: user.uid,
      traceId: requestId,
      chargeMinor: state.billing?.totalChargeMinor ?? 0,
      providerCostEur: state.billing?.totalProviderCostEur ?? 0,
      inputTokens: state.billing?.llmInputTokens ?? 0,
      outputTokens: state.billing?.llmOutputTokens ?? 0,
      durationMs,
    });

    executionLog.info(
      {
        event: "execution.completed",
        status: state.status,
        durationMs,
        outputCount: state.outputs.length,
        observationCount: state.observations.length,
      },
      "Agent execution completed",
    );

    return NextResponse.json(
      {
        executionId,
        requestId,
        status: state.status,
        outputs: state.outputs,
        observations: state.observations,
        async: false,
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    log.error(
      { event: "execution.failed", durationMs, error: safeError(error) },
      "Agent runtime error",
    );

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Agent execution failed",
        requestId,
      },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}

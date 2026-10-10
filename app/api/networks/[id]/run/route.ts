import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { executionLogger, safeError } from "@/lib/observability/logger";
import { recordExecutionMetrics } from "@/lib/observability/otel";
import { tickQueueConfigured, enqueueMissionTick } from "@/lib/queue/tick-queue";
import {
  createQueuedMission,
  markMissionEnqueueFailed,
} from "@/lib/queue/mission-queue";
import { getNetwork } from "@/lib/agents/networks/repository";
import { buildNetworkMissionPlan, networkExecutionPolicy, networkRuntimeAgentConfig } from "@/lib/agents/networks/runner";
import { AgentRuntime } from "@/lib/agents/runtime/runner";
import { OutcomeContractSchema } from "@/lib/agents/outcome-contract";
import { applyOutcomeCredit, shouldCreditOutcomeFailure } from "@/lib/billing/outcome-credits";

/**
 * LANCEMENT D'UNE MISSION D'ÉQUIPE (concept #3 « Agent-as-a-Company ») :
 * l'objectif est confié au RÉSEAU PERSISTANT — plan construit depuis sa
 * composition (coordinateur + membres + synthèse), exécution par le runtime
 * standard (file QStash quand configurée, HITL, facturation, porte de
 * résultat). Même contrat d'honnêteté que /api/agents/run.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RunNetworkSchema = z.object({
  objective: z.string().min(3).max(50_000),
  outcomeContract: OutcomeContractSchema.optional(),
  /** « auto » (défaut) : async si la file est configurée, sinon sync. */
  mode: z.enum(["auto", "async", "sync"]).optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const log = executionLogger({ requestId: request.headers.get("x-request-id")?.trim() || "network-run" });
  const startedAt = Date.now();
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const network = await getNetwork(user.uid, id);
    if (!network || network.status !== "active") {
      return NextResponse.json({ error: "Réseau introuvable ou inactif" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = RunNetworkSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const executionId = randomUUID();
    const plan = buildNetworkMissionPlan({ network, objective: parsed.data.objective, executionId });
    const agentConfig = networkRuntimeAgentConfig(network);

    // ---- File d'attente (mode async) --------------------------------
    const wantsAsync = parsed.data.mode === "async" || (parsed.data.mode !== "sync" && tickQueueConfigured());
    if (wantsAsync && tickQueueConfigured()) {
      const runId = randomUUID();
      try {
        await createQueuedMission({
          runId,
          executionId,
          userId: user.uid,
          objective: parsed.data.objective,
          ...(network.orgId ? { orgId: network.orgId } : {}),
          ...(parsed.data.outcomeContract ? { outcomeContract: parsed.data.outcomeContract } : {}),
          plan,
        });
        // ORIGINE CANONIQUE (fix CodeQL request-forgery) : enqueueMissionTick
        // résout GEN3IA_APP_ORIGIN en interne (allowlist serveur) — aucune
        // origine dérivée de la requête entrante (falsifiable).
        const published = await enqueueMissionTick(runId);
        log.info({ event: "network.mission.queued", runId, networkId: network.id, steps: plan.steps.length }, "Mission d'équipe enfilée");
        return NextResponse.json(
          {
            runId,
            executionId,
            networkId: network.id,
            status: "queued",
            async: true,
            statusUrl: `/api/agents/runs/${runId}`,
            streamUrl: `/api/agents/runs/${runId}/stream`,
            pollSeconds: 2,
            ...(published.ok ? { messageId: published.messageId } : {}),
          },
          { status: 202 },
        );
      } catch (error) {
        if (parsed.data.mode === "async") {
          await markMissionEnqueueFailed(runId, error);
          return NextResponse.json(
            { error: `File d'attente indisponible : ${error instanceof Error ? error.message : String(error)}` },
            { status: 502 },
          );
        }
        log.warn({ event: "network.mission.enqueue.fallback", error: safeError(error) }, "File indisponible — repli synchrone");
      }
    }

    // ---- Exécution synchrone (fallback / explicite) ------------------
    const runtime = new AgentRuntime({
      userId: user.uid,
      objective: parsed.data.objective,
      plan,
      policy: networkExecutionPolicy(),
      agent: agentConfig,
      ...(network.orgId ? { orgId: network.orgId } : {}),
      ...(parsed.data.outcomeContract ? { outcomeContract: parsed.data.outcomeContract } : {}),
    });
    const state = await runtime.run();

    if (shouldCreditOutcomeFailure({ contractPresent: Boolean(parsed.data.outcomeContract), missionStatus: state.status })) {
      void applyOutcomeCredit({
        userId: user.uid,
        executionId,
        totalChargeMinor: state.billing?.totalChargeMinor ?? 0,
        missionStatus: state.status,
      }).catch(() => undefined);
    }

    recordExecutionMetrics({
      executionId,
      status: state.status,
      orgId: network.orgId,
      userId: user.uid,
      traceId: request.headers.get("x-request-id")?.trim() || executionId,
      chargeMinor: state.billing?.totalChargeMinor ?? 0,
      providerCostEur: state.billing?.totalProviderCostEur ?? 0,
      inputTokens: state.billing?.llmInputTokens ?? 0,
      outputTokens: state.billing?.llmOutputTokens ?? 0,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      executionId,
      networkId: network.id,
      status: state.status,
      outputs: state.outputs,
      outcomeVerification: state.outcomeVerification,
      async: false,
    });
  } catch (error) {
    log.error({ event: "network.mission.failed", error: safeError(error) }, "Mission d'équipe en échec");
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Mission d'équipe impossible" },
      { status: errorStatus(error, 500) },
    );
  }
}

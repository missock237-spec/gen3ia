import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { authenticateDeveloper } from "@/lib/extensions/developer-keys";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getAgentForOwner } from "@/lib/agents/repository";
import { createPersonalizedPlan, policyForAgent } from "@/lib/agents/personalized-plan";
import { AgentRuntime } from "@/lib/agents/runtime/runner";
import { executionLogger, safeError } from "@/lib/observability/logger";
import { recordExecutionMetrics } from "@/lib/observability/otel";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Étape 7 du plan 20 — « Agent gen appelable par API ».
 *
 * POST /api/v1/agents/{agentId}/run — exécute une mission sur un agent
 * personnalisé (créé via le Studio ou Agent gen) depuis n'importe quel
 * client externe : n8n, script, app mobile, webhook…
 *
 * Authentification (même chaîne que les endpoints développeur) :
 *   Authorization: Bearer g3x_…   +   X-Gen3ia-Project-Id: <projet lié>
 *
 * Le pipeline d'exécution est EXACTEMENT celui de la route session
 * (/api/agents/[id]/run) : plan personnalisé dérivé de la configuration de
 * l'agent, politique de sécurité dérivée de son type, mêmes garde-fous
 * (HITL, quotas, facturation, audit). Aucune exécution à moitié : les
 * approbations humaines requises apparaissent dans les observations.
 */

interface RouteContext {
  params: Promise<{ agentId: string }>;
}

const RunSchema = z.object({
  objective: z.string().trim().min(3).max(20_000),
});

function authStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (/Clé API|API key|authorization|Bearer|revoked|X-Gen3ia-Project-Id|project/i.test(message)) return 401;
  if (/Developer access required|not the owner|Administrator/i.test(message)) return 403;
  return 500;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  const startedAt = Date.now();
  const log = executionLogger({ requestId });

  try {
    // 1) Authentification par clé API développeur (g3x_…, projet lié requis).
    const identity = await authenticateDeveloper(request);

    const limit = await enforceRateLimit(`api-agent-run:${identity.userId}`, {
      limit: 30,
      windowMs: 5 * 60 * 1000,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop d'exécutions API rapprochées. Réessayez dans quelques minutes.", requestId },
        { status: 429, headers: { "x-request-id": requestId } },
      );
    }

    // 2) Propriété réelle : l'agent doit appartenir au propriétaire de la clé.
    const { agentId } = await context.params;
    const agent = await getAgentForOwner(identity.userId, agentId);
    if (!agent) {
      return NextResponse.json(
        { error: "Agent introuvable ou inaccessible avec cette clé.", requestId },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    }
    if (agent.status !== "active") {
      return NextResponse.json(
        { error: `L'agent est ${agent.status}. Activez-le avant de l'exécuter via l'API.`, requestId },
        { status: 409, headers: { "x-request-id": requestId } },
      );
    }

    // 3) Objectif : le contrat d'entrée minimal de l'API.
    const parsed = RunSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Objectif invalide (3 à 20000 caractères).", issues: parsed.error.flatten(), requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }

    // 4) Pipeline identique à la route session : plan + politique dérivés de
    //    la configuration réelle de l'agent (whitelist d'outils résolue).
    const executionId = randomUUID();
    const plan = createPersonalizedPlan(agent, parsed.data.objective, executionId);
    const policy = policyForAgent(agent);
    const executionLog = log.child({ executionId, userId: identity.userId, agentId: agent.id, via: identity.via });

    executionLog.info(
      { event: "api.agent.execution.started", stepCount: plan.steps.length, type: agent.type },
      "Exécution d'agent via API publique démarrée",
    );

    const runtime = new AgentRuntime({
      userId: identity.userId,
      projectId: agent.projectId,
      objective: parsed.data.objective,
      plan,
      policy,
      signal: request.signal,
      agent: {
        agentId: agent.id,
        name: agent.name,
        type: agent.type,
        systemPrompt: agent.systemPrompt,
        provider: agent.modelStrategy === "fixed" ? agent.preferredProvider : undefined,
        model: agent.modelStrategy === "fixed" ? agent.preferredModel : undefined,
        // Cloisonnement multi-tenant (Task 58) : l'exécution porte
        // l'organisation de l'agent (facturation et vues par org).
        orgId: agent.orgId,
      },
    });

    const state = await runtime.run();
    const durationMs = Date.now() - startedAt;

    // Métriques OTel (Task 59) : coût par organisation (no-op si export désactivé).
    recordExecutionMetrics({
      executionId,
      status: state.status,
      orgId: agent.orgId,
      userId: identity.userId,
      agentId: agent.id,
      traceId: requestId,
      chargeMinor: state.billing?.totalChargeMinor ?? 0,
      providerCostEur: state.billing?.totalProviderCostEur ?? 0,
      inputTokens: state.billing?.llmInputTokens ?? 0,
      outputTokens: state.billing?.llmOutputTokens ?? 0,
      durationMs,
    });

    executionLog.info(
      { event: "api.agent.execution.completed", status: state.status, durationMs },
      "Exécution d'agent via API terminée",
    );

    return NextResponse.json(
      {
        executionId,
        requestId,
        agent: { id: agent.id, name: agent.name, type: agent.type },
        status: state.status,
        outputs: state.outputs,
        observations: state.observations,
        billing: state.billing,
        durationMs,
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    const safe = safeError(error);
    log.error({ event: "api.agent.execution.failed", error: safe }, "Erreur exécution d'agent via API");
    const message = error instanceof Error ? error.message : "Exécution impossible";
    const insufficient = /wallet|balance|funds/i.test(message);
    return NextResponse.json(
      {
        error: insufficient
          ? "Solde du portefeuille insuffisant. Rechargez votre wallet dans Facturation."
          : message,
        requestId,
      },
      { status: insufficient ? 402 : authStatus(error), headers: { "x-request-id": requestId } },
    );
  }
}

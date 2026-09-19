import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { rateLimit } from "@/lib/security/rate-limit";
import { getAgentForOwner } from "@/lib/agents/repository";
import { createPersonalizedPlan, policyForAgent } from "@/lib/agents/personalized-plan";
import { AgentRuntime } from "@/lib/agents/runtime/runner";
import { executionLogger, safeError } from "@/lib/observability/logger";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const RunSchema = z.object({
  objective: z.string().trim().min(3).max(20_000),
});

/**
 * Execute immediatement une mission avec un agent personnalise du Studio.
 * L'agent (nom, prompt systeme, type, modele prefere) pilote l'execution :
 * le plan est construit depuis sa configuration, sa politique de securite
 * derive de son type, et son prompt systeme est injecte dans chaque step LLM.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  const startedAt = Date.now();
  const log = executionLogger({ requestId });

  try {
    const user = await requireUser(request);
    const limit = rateLimit(`agent-run:${user.uid}`, { limit: 12, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop d'executions rapprochees. Reessayez dans quelques minutes.", requestId },
        { status: 429, headers: { "x-request-id": requestId } },
      );
    }

    const { id } = await context.params;
    const agent = await getAgentForOwner(user.uid, id);
    if (!agent) {
      return NextResponse.json({ error: "Agent introuvable", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }
    if (agent.status !== "active") {
      return NextResponse.json(
        { error: `L'agent est ${agent.status}. Activez-le avant de l'executer.`, requestId },
        { status: 409, headers: { "x-request-id": requestId } },
      );
    }

    const parsed = RunSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Objectif invalide (3 a 20000 caracteres)", issues: parsed.error.flatten(), requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }

    const executionId = randomUUID();
    const plan = createPersonalizedPlan(agent, parsed.data.objective, executionId);
    const policy = policyForAgent(agent);
    const executionLog = log.child({ executionId, userId: user.uid, agentId: agent.id });

    executionLog.info(
      { event: "agent.execution.started", stepCount: plan.steps.length, type: agent.type },
      "Execution d'agent personnalise demarree",
    );

    const runtime = new AgentRuntime({
      userId: user.uid,
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
      },
    });

    const state = await runtime.run();
    const durationMs = Date.now() - startedAt;

    executionLog.info({ event: "agent.execution.completed", status: state.status, durationMs }, "Execution d'agent terminee");

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
    log.error({ event: "agent.execution.failed", error: safe }, "Erreur execution d'agent");
    const message = error instanceof Error ? error.message : "Execution impossible";
    const insufficient = /wallet|balance|funds/i.test(message);
    return NextResponse.json(
      { error: insufficient ? "Solde du portefeuille insuffisant. Rechargez votre wallet dans Facturation." : message, requestId },
      { status: insufficient ? 402 : 500, headers: { "x-request-id": requestId } },
    );
  }
}

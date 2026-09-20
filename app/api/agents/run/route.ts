import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import {
  AgentRuntime,
  RuntimePlanSchema,
} from "@/lib/agents/runtime";
import { executionLogger, safeError } from "@/lib/observability/logger";

const RunAgentSchema = z.object({
  objective: z.string().min(3).max(50_000),
  projectId: z.string().trim().min(1).max(128).optional(),
  plan: RuntimePlanSchema
    .omit({ executionId: true, objective: true })
    .optional(),
});

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  const log = executionLogger({ requestId });
  const startedAt = Date.now();

  try {
    const user = await requireUser(request);
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

    const executionId = randomUUID();
    const executionLog = log.child({ executionId, userId: user.uid, projectId: parsed.data.projectId });

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
    });

    const state = await runtime.run();
    const durationMs = Date.now() - startedAt;

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
      { status: 500, headers: { "x-request-id": requestId } },
    );
  }
}

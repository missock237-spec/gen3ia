import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { createAutonomousPlan } from "@/lib/agents/autonomous/planner";
import { MultiAgentOrchestrator } from "@/lib/agents/orchestrator/orchestrator";
import type { AgentNode } from "@/lib/agents/orchestrator/types";
import { generate } from "@/lib/ai/router";
import { errorStatus } from "@/lib/security/http-errors";

const RequestSchema = z.object({
  objective: z.string().trim().min(3).max(20_000),
  context: z.string().max(100_000).optional(),
  constraints: z.array(z.string().max(2_000)).max(50).optional(),
  autonomous: z.boolean().default(true),
  maxIterations: z.number().int().min(1).max(20).default(10),
});

function roleTask(role: AgentNode["role"]): "agent" | "research" | "coding" | "document" {
  if (role === "researcher") return "research";
  if (role === "developer" || role === "coder" || role === "tester") return "coding";
  if (role === "file_manager") return "document";
  return "agent";
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const body = await request.json();
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

    const task = { ...parsed.data, userId: user.uid };
    const plan = createAutonomousPlan(task);

    const orchestrator = new MultiAgentOrchestrator({
      async execute(agent, context) {
        if (agent.requiresApproval && parsed.data.autonomous !== true) {
          throw new Error(`Approval required before executing agent ${agent.id}`);
        }

        const response = await generate({
          task: roleTask(agent.role),
          preferFree: true,
          messages: [
            {
              role: "system",
              content: `You are the ${agent.role} agent inside Gen3ia. Work only on the assigned objective. Do not claim that a file, deployment, external action, test, or web result was completed unless the corresponding tool actually produced that result. Return concrete, machine-usable output.`,
            },
            {
              role: "user",
              content: JSON.stringify({
                objective: context.objective,
                agentObjective: agent.objective,
                requiredSkills: agent.requiredSkills,
                requiredTools: agent.requiredTools,
                dependencyResults: context.dependencyResults,
                context: parsed.data.context,
                constraints: parsed.data.constraints,
                iterationBudget: Math.min(agent.maxIterations, parsed.data.maxIterations),
              }),
            },
          ],
          maxTokens: 8_000,
        });

        return {
          agentId: agent.id,
          role: agent.role,
          provider: response.provider,
          model: response.model,
          text: response.text,
          usage: response.usage,
        };
      },
    });

    const state = await orchestrator.run(plan);

    return NextResponse.json({
      success: state.status === "completed",
      executionId: state.executionId,
      status: state.status,
      plan,
      results: state.results,
      error: state.error,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
    }, { status: state.status === "failed" ? 500 : 200 });
  } catch (error) {
    console.error("Autonomous agent execution error:", error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Autonomous execution failed",
    }, { status: errorStatus(error, 500) });
  }
}

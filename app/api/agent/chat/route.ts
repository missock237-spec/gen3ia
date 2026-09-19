import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { rateLimit } from "@/lib/security/rate-limit";
import { planUniversalAgent } from "@/lib/agents/runtime/unified-agent";
import { AgentRuntime } from "@/lib/agents/runtime/runner";
import { DEFAULT_EXECUTION_POLICY, type ExecutionPolicy } from "@/lib/security/execution-policy";
import { getToolSecurityDefinition } from "@/lib/security/tool-permissions";
import { createActionApproval, listActionApprovals } from "@/lib/agents/action-approvals";
import type { RuntimePlan } from "@/lib/agents/runtime/types";
import { appendMessage, createConversation, getConversation } from "@/lib/chat/repository";

const Body = z.object({
  message: z.string().trim().min(1).max(20_000),
  conversationId: z.string().trim().min(1).max(256).optional(),
});

function buildPolicy(plan: RuntimePlan): ExecutionPolicy {
  const tools = [...new Set(
    plan.steps
      .filter((step) => step.type === "tool" || step.type === "research")
      .map((step) => step.toolName)
      .filter((name): name is string => Boolean(name))
      .concat(plan.steps.some((step) => step.type === "code") ? ["code.execute"] : []),
  )];

  const permissions = new Set<ExecutionPolicy["permissions"][number]>(["tool.read"]);
  let allowNetwork = false;
  let allowFileWrite = false;
  let allowFileDelete = false;
  let allowCodeExecution = false;
  let allowAgentTerminal = false;
  let allowCamera = false;
  let allowExternalApps = false;

  for (const tool of tools) {
    const definition = getToolSecurityDefinition(tool);
    for (const permission of definition.requiredPermissions) permissions.add(permission);
    if (definition.network) allowNetwork = true;
    if (definition.filesystemWrite) allowFileWrite = true;
    if (definition.destructive) allowFileDelete = true;
    if (tool === "code.execute") allowCodeExecution = true;
    if (tool === "terminal.execute") allowAgentTerminal = true;
    if (tool === "camera.capture") allowCamera = true;
    if (definition.externalApp) allowExternalApps = true;
  }

  return {
    ...DEFAULT_EXECUTION_POLICY,
    allowedTools: tools,
    permissions: [...permissions],
    maxSteps: Math.max(50, plan.steps.length + 10),
    allowNetwork,
    allowFileWrite,
    allowFileDelete,
    allowCodeExecution,
    allowAgentTerminal,
    allowCamera,
    allowExternalApps,
  };
}

function finalResponseText(plan: RuntimePlan, outputs: Record<string, unknown>): string {
  const candidates = [...plan.steps].reverse().filter((step) => ["llm", "document", "media", "research"].includes(step.type));
  for (const step of candidates) {
    const value = outputs[step.id];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "Le plan de l’agent a été exécuté. Consultez les étapes et résultats ci-dessous.";
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const chatLimit = rateLimit(`agent-chat:${user.uid}`, { limit: 60, windowMs: 5 * 60 * 1000 });
    if (!chatLimit.allowed) {
      return NextResponse.json({ error: "Trop de messages rapproches. Reessayez dans quelques instants." }, { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(chatLimit.retryAfterMs / 1000))) } });
    }
    const body = Body.parse(await request.json());

    let conversationId = body.conversationId;
    if (conversationId) {
      if (!(await getConversation(user.uid, conversationId))) {
        return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
      }
    } else {
      const conversation = await createConversation(user.uid, body.message.slice(0, 80));
      conversationId = conversation.id;
    }

    await appendMessage({
      conversationId,
      userId: user.uid,
      role: "user",
      content: body.message,
    });

    const plan = await planUniversalAgent(user.uid, body.message);
    const approvalSteps = plan.steps.filter((step) =>
      step.type === "tool" && (step.requiresApproval || step.sideEffect),
    );

    if (approvalSteps.length > 0) {
      const checkpoint = {
        executionId: plan.executionId,
        userId: user.uid,
        objective: body.message,
        conversationId,
        status: "pending" as const,
        plan,
        observations: [],
        evaluations: [],
        outputs: {},
        iteration: 0,
        totalRetries: 0,
        maxTotalRetries: 15,
        billing: { currency: "XAF", totalChargeMinor: 0, totalProviderCostEur: 0, llmInputTokens: 0, llmOutputTokens: 0 },
      };
      const { createCheckpoint } = await import("@/lib/agents/runtime/checkpoint");
      await createCheckpoint(checkpoint);

      const approvals = await Promise.all(approvalSteps.map(async (step) => {
        const approval = await createActionApproval({
          ownerId: user.uid,
          executionId: plan.executionId,
          role: "admin",
          toolSlug: step.toolName ?? step.type,
          arguments: { ...step.input, __stepId: step.id },
          reason: step.description,
        });
        step.status = "waiting_approval";
        return approval;
      }));

      await appendMessage({
        conversationId,
        userId: user.uid,
        role: "assistant",
        content: "J’ai préparé le plan. Une ou plusieurs actions externes nécessitent votre confirmation avant que l’agent ne les exécute.",
      });

      return NextResponse.json({
        mode: "agent",
        status: "waiting_approval",
        executionId: plan.executionId,
        conversationId,
        objective: body.message,
        plan,
        approvals: approvals.map((item) => ({
          id: item.id,
          toolSlug: item.toolSlug,
          reason: item.reason,
          status: item.status,
          expiresAt: item.expiresAt,
          stepId: typeof item.arguments.__stepId === "string" ? item.arguments.__stepId : undefined,
        })),
      });
    }

    const runtime = new AgentRuntime({
      userId: user.uid,
      objective: body.message,
      plan,
      policy: buildPolicy(plan),
    });

    let result;
    try {
      result = await runtime.run();
    } catch (error) {
      return NextResponse.json({
        mode: "agent",
        status: "failed",
        executionId: plan.executionId,
        conversationId,
        objective: body.message,
        plan,
        error: error instanceof Error ? error.message : "Agent execution failed.",
        approvals: await listActionApprovals(user.uid, plan.executionId),
      }, { status: 400 });
    }

    const currentApprovals = await listActionApprovals(user.uid, plan.executionId);
    const pending = currentApprovals.filter((item) => item.status === "pending");

    const status = pending.length > 0 ? "waiting_approval" : result.status;
    const finalText = finalResponseText(result.plan, result.outputs);
    await appendMessage({
      conversationId,
      userId: user.uid,
      role: "assistant",
      content: status === "waiting_approval"
        ? "J’ai préparé et exécuté les étapes autorisées. Une ou plusieurs actions nécessitent maintenant votre confirmation."
        : finalText,
    });

    return NextResponse.json({
      mode: "agent",
      status,
      executionId: result.executionId,
      conversationId,
      objective: result.objective,
      plan: result.plan,
      observations: result.observations,
      outputs: result.outputs,
      billing: result.billing,
      approvals: currentApprovals.map((item) => ({
        id: item.id,
        toolSlug: item.toolSlug,
        reason: item.reason,
        status: item.status,
        expiresAt: item.expiresAt,
        stepId: typeof item.arguments.__stepId === "string" ? item.arguments.__stepId : undefined,
      })),
      finalText: status === "completed" ? finalText : undefined,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent request failed." },
      { status: 400 },
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import {
  approveAction,
  claimActionExecution,
  failAction,
  listActionApprovals,
  rejectAction,
} from "@/lib/agents/action-approvals";
import { loadCheckpoint } from "@/lib/agents/runtime/checkpoint";
import { AgentRuntime } from "@/lib/agents/runtime/runner";
import { DEFAULT_EXECUTION_POLICY, type ExecutionPolicy } from "@/lib/security/execution-policy";
import { getToolSecurityDefinition } from "@/lib/security/tool-permissions";
import type { RuntimePlan } from "@/lib/agents/runtime/types";
import { appendMessage } from "@/lib/chat/repository";
import { errorStatus } from "@/lib/security/http-errors";

const Body = z.object({ approvalId: z.string().min(1).max(256), action: z.enum(["approve", "reject"]).default("approve") });

/**
 * Reconstruit le texte final affiché a l'utilisateur après une exécution
 * approuvée : dernier résultat textuel utile (llm, document, media, research)
 * produit par le runtime, avec message de repli.
 */
function finalResponseText(plan: RuntimePlan, outputs: Record<string, unknown>): string {
  const candidates = [...plan.steps].reverse().filter((step) => ["llm", "document", "media", "research"].includes(step.type));
  for (const step of candidates) {
    const value = outputs[step.id];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "L’exécution de l’agent est terminée. Consultez les étapes et résultats affichés dans l’espace Agent.";
}

function buildPolicy(plan: RuntimePlan): ExecutionPolicy {
  const tools = [...new Set(plan.steps
    .filter((step) => step.type === "tool" || step.type === "research")
    .map((step) => step.toolName)
    .filter((name): name is string => Boolean(name))
    .concat(plan.steps.some((step) => step.type === "code") ? ["code.execute"] : []))];

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

export async function POST(request: NextRequest) {
  const user = await requireUser(request);
  const { approvalId, action } = Body.parse(await request.json());

  try {
    if (action === "reject") {
      const rejected = await rejectAction(user.uid, approvalId);
      // Trace de conversation : le refus fait partie de l'historique.
      const checkpoint = await loadCheckpoint(rejected.executionId);
      if (checkpoint?.conversationId) {
        await appendMessage({
          conversationId: checkpoint.conversationId,
          userId: user.uid,
          role: "assistant",
          content: "Vous avez refusé cette action. L'agent ne l'exécutera pas : la mission s'arrête ici pour votre sécurité.",
        }).catch(() => undefined);
      }
      return NextResponse.json({
        status: "rejected_by_user",
        executionId: rejected.executionId,
        finalText: "Vous avez refusé cette action. L'agent ne l'exécutera pas : la mission s'arrête ici pour votre sécurité.",
        plan: checkpoint?.plan,
      });
    }
    const approval = await approveAction(user.uid, approvalId);
    const executionId = approval.executionId;
    const state = await loadCheckpoint(executionId);

    if (!state || state.userId !== user.uid) {
      return NextResponse.json({ error: "Agent execution not found." }, { status: 404 });
    }

    const approvals = await listActionApprovals(user.uid, executionId);
    const pending = approvals.filter((item) => item.status === "pending");
    if (pending.length > 0) {
      return NextResponse.json({
        status: "waiting_approval",
        executionId,
        approvals: approvals.map((item) => ({ id: item.id, toolSlug: item.toolSlug, status: item.status, reason: item.reason, expiresAt: item.expiresAt })),
      });
    }

    const rejected = approvals.find((item) => item.status === "rejected" || item.status === "expired" || item.status === "failed");
    if (rejected) {
      return NextResponse.json({
        status: "blocked",
        executionId,
        error: `Approval ${rejected.id} is ${rejected.status}.`,
      }, { status: 409 });
    }

    const claimed: string[] = [];
    try {
      for (const item of approvals) {
        if (item.status === "approved") {
          await claimActionExecution(user.uid, item.id);
          claimed.push(item.id);
        }
      }

      const claimedByStep = new Map(
        claimed.map((id) => {
          const item = approvals.find((approvalItem) => approvalItem.id === id)!;
          return [String(item.arguments.__stepId ?? ""), id];
        }),
      );

      for (const step of state.plan.steps) {
        const id = claimedByStep.get(step.id);
        if (id) {
          step.status = "pending";
          step.input = { ...step.input, __stepId: step.id, approvalId: id };
        }
      }

      const runtime = new AgentRuntime({
        userId: user.uid,
        objective: state.objective,
        plan: state.plan,
        policy: buildPolicy(state.plan),
      });
      const result = await runtime.run();

      for (const id of claimed) {
        await (result.status === "completed"
          ? import("@/lib/agents/action-approvals").then(({ completeAction }) => completeAction(user.uid, id, result.outputs))
          : import("@/lib/agents/action-approvals").then(({ failAction: markFailed }) => markFailed(user.uid, id, result.error ?? "Agent execution failed.")));
      }

      return NextResponse.json({
        status: result.status,
        executionId: result.executionId,
        conversationId: state.conversationId,
        finalText: finalResponseText(result.plan, result.outputs),
        objective: result.objective,
        plan: result.plan,
        observations: result.observations,
        outputs: result.outputs,
        billing: result.billing,
      });
    } catch (error) {
      await Promise.all(claimed.map((id) => failAction(user.uid, id, error).catch(() => undefined)));
      throw error;
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Approval/execution failed." },
      { status: errorStatus(error, 400) },
    );
  }
}

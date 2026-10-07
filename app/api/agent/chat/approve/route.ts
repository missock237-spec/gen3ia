import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
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
import { reconcileAgentRun } from "@/lib/agents/conversation-run";
import { buildFinalResponse } from "@/lib/agents/final-response";
import { deliverMissionToConversation } from "@/lib/agents/mission-delivery";
import { enqueueMissionContinuation } from "@/lib/queue/mission-continuation";
import { errorCode, errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";
// La reprise après approbation peut dépasser la fenêtre par défaut ; elle
// est bornée proprement par batchDeadlineMs puis enfilée si nécessaire.
export const maxDuration = 300;
const APPROVE_SYNC_BUDGET_MS = 290_000;

const Body = z.object({ approvalId: z.string().min(1).max(256), action: z.enum(["approve", "reject"]).default("approve") });

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
  try {
    // Auth + validation DANS le try : une session absente doit produire un
    // 401 structuré (errorStatus), jamais un 500 opaque — l'UI traite sinon
    // une déconnexion comme une panne système.
    const user = await requireUser(request);
    // Approuver = REPRENDRE l'agent (appels LLM + outils, même classe de coût
    // que /api/agent/chat/continue 20/5min) : la route était authentifiée
    // mais sans quota.
    const limit = await enforceRateLimit(`agent-approve:${user.uid}`, { limit: 20, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop d'approbations rapprochées. Reessayez dans quelques minutes." }, { status: 429 });
    }
    const { approvalId, action } = Body.parse(await request.json());

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
        batchDeadlineMs: Date.now() + APPROVE_SYNC_BUDGET_MS,
      });
      const result = await runtime.run();

      for (const id of claimed) {
        await (result.status === "completed"
          ? import("@/lib/agents/action-approvals").then(({ completeAction }) => completeAction(user.uid, id, result.outputs))
          : import("@/lib/agents/action-approvals").then(({ failAction: markFailed }) => markFailed(user.uid, id, result.error ?? "Agent execution failed.")));
      }

      // LIVRAISON UNIFIÉE (exigence production) : run réconcilié + message
      // final honnête + manifest des livrables réels — le même passage que
      // les missions en file, y compris après une approbation HITL.
      if (state.conversationId) {
        await deliverMissionToConversation({
          userId: user.uid,
          conversationId: state.conversationId,
          state: result,
        }).catch(() => undefined);
      } else {
        await reconcileAgentRun({
          userId: user.uid,
          conversationId: "",
          plan: result.plan,
          status: result.status,
          outputs: result.outputs,
          observations: result.observations,
          billing: result.billing,
          finalText: result.status === "completed" ? buildFinalResponse(result.plan, result.outputs, { ...(result.outcomeVerification ? { outcome: result.outcomeVerification } : {}) }).text : undefined,
          error: result.error,
        }).catch(() => undefined);
      }
      // Continuation arrière-plan si l'échéance de tranche a coupé la mission.
      let continuation: { queued: boolean; runId?: string; reason?: string } | undefined;
      if (result.status === "paused" && result.plan.steps.some((step) => step.status === "pending")) {
        continuation = await enqueueMissionContinuation({
          userId: user.uid,
          executionId: result.executionId,
          objective: result.objective || state.objective,
          plan: result.plan,
          ...(state.conversationId ? { conversationId: state.conversationId } : {}),
        });
      }

      return NextResponse.json({
        status: result.status,
        executionId: result.executionId,
        conversationId: state.conversationId,
        finalText: result.status === "completed"
          ? buildFinalResponse(result.plan, result.outputs, { ...(result.outcomeVerification ? { outcome: result.outcomeVerification } : {}) }).text
          : undefined,
        objective: result.objective,
        plan: result.plan,
        observations: result.observations,
        outputs: result.outputs,
        billing: result.billing,
        ...(continuation ? { continuation } : {}),
      });
    } catch (error) {
      await Promise.all(claimed.map((id) => failAction(user.uid, id, error).catch(() => undefined)));
      throw error;
    }
  } catch (error) {
    // Convention contract-first : le code machine (AUTH_REQUIRED…) voyage
    // avec le message — l'UI distingue déconnexion et panne réelle.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Approval/execution failed.", code: errorCode(error) },
      { status: errorStatus(error, 400) },
    );
  }
}

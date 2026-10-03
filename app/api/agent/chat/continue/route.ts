import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { loadCheckpoint } from "@/lib/agents/runtime/checkpoint";
import { AgentRuntime } from "@/lib/agents/runtime/runner";
import { DEFAULT_EXECUTION_POLICY, type ExecutionPolicy } from "@/lib/security/execution-policy";
import { getToolSecurityDefinition } from "@/lib/security/tool-permissions";
import type { RuntimePlan, RuntimeStep } from "@/lib/agents/runtime/types";
import { reconcileAgentRun } from "@/lib/agents/conversation-run";
import { buildFinalResponse } from "@/lib/agents/final-response";
import { deliverMissionToConversation } from "@/lib/agents/mission-delivery";
import { createQueuedMission } from "@/lib/queue/mission-queue";
import { missionQueueConfigured, publishMissionTick } from "@/lib/queue/qstash";
import { enqueueMissionContinuation } from "@/lib/queue/mission-continuation";
import { errorStatus, errorBody } from "@/lib/security/http-errors";

const Body = z.object({
  executionId: z.string().trim().min(1).max(256),
  conversationId: z.string().trim().min(1).max(256).optional(),
});

/** Un `running` plus vieux que ce seuil est un kill plateforme (fonction tuée) : reprenable. */
const STALE_RUNNING_MS = 10 * 60 * 1000;

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

export const runtime = "nodejs";
// Reprise synchrone (repli) bornée proprement par batchDeadlineMs.
export const maxDuration = 300;
const RESUME_SYNC_BUDGET_MS = 290_000;

export async function POST(request: NextRequest) {
  try {
    // Auth DANS le try : session absente → 401 structuré, jamais un 500.
    const user = await requireUser(request);
    const continueLimit = await enforceRateLimit(`agent-continue:${user.uid}`, { limit: 20, windowMs: 5 * 60 * 1000 });
    if (!continueLimit.allowed) {
      return NextResponse.json({ error: "Trop de relances rapprochées. Reessayez dans quelques instants.", code: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(continueLimit.retryAfterMs / 1000))) } });
    }
    const body = Body.parse(await request.json());
    const state = await loadCheckpoint(body.executionId);
    if (!state || state.userId !== user.uid) {
      return NextResponse.json({ error: "Mission introuvable.", code: "NOT_FOUND" }, { status: 404 });
    }
    if (state.status === "completed") {
      return NextResponse.json({ error: "Cette mission est déjà terminée.", code: "CONFLICT" }, { status: 409 });
    }
    if (state.status === "cancelled") {
      return NextResponse.json({ error: "Cette mission a été arrêtée définitivement : elle n'est plus reprenable.", code: "CONFLICT" }, { status: 409 });
    }
    if (state.status === "running") {
      const startedAt = state.startedAt ? Date.parse(state.startedAt) : 0;
      if (Number.isFinite(startedAt) && Date.now() - startedAt < STALE_RUNNING_MS) {
        return NextResponse.json({ error: "La mission est encore en cours d'exécution. Revenez dans un instant.", code: "CONFLICT" }, { status: 409 });
      }
    }
    if (state.plan.steps.some((step) => step.status === "waiting_approval")) {
      return NextResponse.json({ error: "Une étape attend votre approbation : validez-la depuis le panneau de la mission pour continuer.", code: "CONFLICT" }, { status: 409 });
    }

    // Reprise NON-AMNÉSIQUE : les étapes échouées (ou gelées « running » par
    // un kill plateforme) repartent à zéro sur demande EXPLICITE de
    // l'utilisateur ; les étapes complétées sont sautées et leurs sorties
    // nourrissent à nouveau les étapes dépendantes.
    const resumedPlan: RuntimePlan = {
      ...state.plan,
      steps: state.plan.steps.map((step: RuntimeStep): RuntimeStep => {
        if (step.status === "failed" || step.status === "running") {
          return { ...step, status: "pending" as const };
        }
        return step;
      }),
    };

    const conversationId = state.conversationId ?? body.conversationId;

    // REPRISE SUR LA FILE (exigence production) : quand la file est
    // configurée, la reprise s'exécute en arrière-plan, par tranches —
    // déconnecter, rafraîchir ou fermer l'onglet n'interrompt plus jamais la
    // reprise. Le tick final livre le message final + livrables + run.
    if (missionQueueConfigured()) {
      const runId = randomUUID();
      try {
        await createQueuedMission({
          runId,
          executionId: state.executionId,
          userId: user.uid,
          objective: state.objective,
          ...(conversationId ? { conversationId } : {}),
          plan: resumedPlan,
        });
        const origin = process.env.GEN3IA_APP_ORIGIN?.trim() || request.nextUrl.origin;
        await publishMissionTick(origin, runId);
        return NextResponse.json({
          mode: "agent",
          status: "queued",
          runId,
          executionId: state.executionId,
          conversationId,
          objective: state.objective,
          plan: resumedPlan,
          resumed: true,
          pollSeconds: 2,
        }, { status: 202 });
      } catch (error) {
        console.warn("[agent-continue] enfilement impossible — repli synchrone", error instanceof Error ? error.message : error);
      }
    }

    const runtime = new AgentRuntime({
      userId: user.uid,
      objective: state.objective,
      plan: resumedPlan,
      policy: buildPolicy(resumedPlan),
      initialOutputs: state.outputs ?? {},
      batchDeadlineMs: Date.now() + RESUME_SYNC_BUDGET_MS,
      ...(state.conversationId ? { conversationId: state.conversationId } : {}),
    });

    let result;
    try {
      result = await runtime.run();
    } catch (error) {
      return NextResponse.json({
        mode: "agent",
        status: "failed",
        executionId: state.executionId,
        conversationId: state.conversationId ?? body.conversationId,
        objective: state.objective,
        plan: state.plan,
        error: error instanceof Error ? error.message : "La reprise de la mission a échoué.",
        resumable: true,
      }, { status: errorStatus(error, 400) });
    }

    const resultStatus: string = result.status;

    // LIVRAISON UNIFIÉE (run réconcilié + message final + livrables réels).
    let deliveryFinalText: string | undefined;
    if (conversationId) {
      const delivery = await deliverMissionToConversation({
        userId: user.uid,
        conversationId,
        state: result,
      }).catch(() => ({ finalText: undefined as string | undefined, deliverables: [], messageId: undefined }));
      deliveryFinalText = delivery.finalText;
    } else {
      await reconcileAgentRun({
        userId: user.uid,
        conversationId: "",
        plan: result.plan,
        status: result.status,
        outputs: result.outputs,
        observations: result.observations,
        billing: result.billing,
        finalText: resultStatus === "completed" ? buildFinalResponse(result.plan, result.outputs, { ...(result.outcomeVerification ? { outcome: result.outcomeVerification } : {}) }).text : undefined,
        error: result.error,
      }).catch(() => undefined);
    }

    // Continuation arrière-plan si l'échéance de tranche a recoupé la mission.
    let continuation: { queued: boolean; runId?: string; reason?: string } | undefined;
    if (result.status === "paused" && result.plan.steps.some((step) => step.status === "pending")) {
      continuation = await enqueueMissionContinuation({
        userId: user.uid,
        executionId: result.executionId,
        objective: result.objective || state.objective,
        plan: result.plan,
        ...(conversationId ? { conversationId } : {}),
        origin: process.env.GEN3IA_APP_ORIGIN?.trim() || request.nextUrl.origin,
      });
    }

    return NextResponse.json({
      mode: "agent",
      status: result.status,
      executionId: result.executionId,
      conversationId,
      objective: result.objective,
      plan: result.plan,
      observations: result.observations,
      outputs: result.outputs,
      billing: result.billing,
      finalText: deliveryFinalText,
      error: result.error,
      resumed: true,
      resumable: resultStatus === "failed",
      ...(continuation ? { continuation } : {}),
    });
  } catch (error) {
    const body = errorBody(error, "La reprise de la mission a échoué.");
    if (body.code === "AUTH_REQUIRED") {
      return NextResponse.json({ error: body.error, code: body.code }, { status: 401 });
    }
    return NextResponse.json(
      { error: body.code === "INVALID_REQUEST" ? body.error : "Impossible de reprendre la mission pour le moment. Réessayez.", code: body.code },
      { status: errorStatus(error, 400) },
    );
  }
}

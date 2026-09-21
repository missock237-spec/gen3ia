import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { rateLimit } from "@/lib/security/rate-limit";
import { planUniversalAgent } from "@/lib/agents/runtime/unified-agent";
import { AgentRuntime } from "@/lib/agents/runtime/runner";
import { DEFAULT_EXECUTION_POLICY, type ExecutionPolicy } from "@/lib/security/execution-policy";
import { getToolSecurityDefinition } from "@/lib/security/tool-permissions";
import { createActionApproval, listActionApprovals } from "@/lib/agents/action-approvals";
import type { RuntimePlan } from "@/lib/agents/runtime/types";
import { appendMessage, createConversation, getConversation, listMessages } from "@/lib/chat/repository";
import { getAgentForOwner } from "@/lib/agents/repository";
import { policyForAgent } from "@/lib/agents/personalized-plan";
import { answerAsAgent, classifyRequest, outOfScopeReply, planAgentTask } from "@/lib/agents/chat-engine";
import { recallAgentContext, recordExchange, shouldSummarize, summarizeConversation } from "@/lib/memory/episodic";
import { describeServersForPrompt } from "@/lib/integrations/mcp/service";
import type { AgentRecord } from "@/lib/agents/schema";

const Body = z.object({
  message: z.string().trim().min(1).max(20_000),
  conversationId: z.string().trim().min(1).max(256).optional(),
  // Chat scopé à un agent personnalisé du Studio : classification,
  // périmètre strict et outils restreints.
  agentId: z.string().trim().min(1).max(128).optional(),
  attachmentPath: z.string().trim().min(1).max(500).optional(),
  attachmentName: z.string().trim().min(1).max(255).optional(),
});

function buildPolicy(plan: RuntimePlan): ExecutionPolicy {
  const tools = [...new Set(
    plan.steps
      .filter((step) => step.type === "tool" || step.type === "research")
      .map((step) => step.toolName)
      .filter((name): name is string => Boolean(name))
      .concat(plan.steps.some((step) => step.type === "research") ? ["web.search"] : [])
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

/**
 * Politique effective d'une mission agent : intersection entre les outils
 * requis par le plan et la whitelist de l'agent. Double barrière avec le
 * filtrage du catalogue au moment de la planification.
 */
function policyForAgentPlan(agent: AgentRecord, plan: RuntimePlan): ExecutionPolicy {
  const agentAllowed = new Set(policyForAgent(agent).allowedTools ?? []);
  const planPolicy = buildPolicy(plan);
  return {
    ...planPolicy,
    allowedTools: (planPolicy.allowedTools ?? []).filter((tool) => agentAllowed.has(tool)),
  };
}

function finalResponseText(plan: RuntimePlan, outputs: Record<string, unknown>): string {
  const candidates = [...plan.steps].reverse().filter((step) => ["llm", "document", "media", "research"].includes(step.type));
  for (const step of candidates) {
    const value = outputs[step.id];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "Le plan de l'agent a été exécuté. Consultez les étapes et résultats ci-dessous.";
}

/** Note de contexte (pièce jointe ou fichier mémoire) ajoutée au message. */
function contextNoteFor(attachmentPath: string | undefined, agent: AgentRecord | null): string | undefined {
  if (attachmentPath) {
    return `[Contexte fourni par l'utilisateur : le fichier « ${attachmentPath} » est disponible dans le stockage Gen3ia. Utilise l'outil file.read pour le consulter si nécessaire.]`;
  }
  if (agent?.memoryFile?.path) {
    return `[Mémoire de l'agent : le fichier « ${agent.memoryFile.name} » (${agent.memoryFile.path}) est disponible dans le stockage Gen3ia. Utilise l'outil file.read pour le consulter dès qu'il peut améliorer ta réponse.]`;
  }
  return undefined;
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const chatLimit = rateLimit(`agent-chat:${user.uid}`, { limit: 60, windowMs: 5 * 60 * 1000 });
    if (!chatLimit.allowed) {
      return NextResponse.json({ error: "Trop de messages rapproches. Reessayez dans quelques instants." }, { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(chatLimit.retryAfterMs / 1000))) } });
    }
    const body = Body.parse(await request.json());

    let agent: AgentRecord | null = null;
    if (body.agentId) {
      agent = await getAgentForOwner(user.uid, body.agentId);
      if (!agent) return NextResponse.json({ error: "Agent introuvable." }, { status: 404 });
      if (agent.status !== "active") {
        return NextResponse.json({ error: `L'agent est ${agent.status}. Activez-le avant de discuter.` }, { status: 409 });
      }
    }

    let conversationId = body.conversationId;
    if (conversationId) {
      if (!(await getConversation(user.uid, conversationId))) {
        return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
      }
    } else {
      const conversation = await createConversation(user.uid, body.message.slice(0, 80));
      conversationId = conversation.id;
    }

    // Historique AVANT l'ajout du message courant (contexte de classification
    // et de réponse en mode chat).
    const history = await listMessages(user.uid, conversationId, 20);

    if (agent) {
      // ────────────────────────────────────────────────────────────────
      // Chemin agent personnalisé : classification → réponse/refus/exécution.
      // ────────────────────────────────────────────────────────────────
      const classification = await classifyRequest(agent, body.message);
      const note = contextNoteFor(body.attachmentPath, agent);

      // Mémoire épisodique : rappel sémantique des échanges passés de cet
      // agent (similarité cosinus sur embeddings) — silence si indisponible.
      const memoryNote = agent.memoryEnabled
        ? await recallAgentContext(user.uid, agent.id, body.message)
        : undefined;
      // Découverte automatique des outils MCP connectés (si l'agent en
      // dispose) : le planificateur connaît serverId + noms d'outils exacts.
      const mcpNote = agent.tools.includes("mcp.call")
        ? await describeServersForPrompt(user.uid)
        : undefined;
      const fullNote = [note, memoryNote, mcpNote].filter(Boolean).join("\n\n") || undefined;

      await appendMessage({
        conversationId,
        userId: user.uid,
        role: "user",
        content: body.message,
      });

      // Hors périmètre : refus professionnel, sans exécution ni coût LLM.
      if (!classification.inScope) {
        const reply = outOfScopeReply(agent, body.message);
        await appendMessage({ conversationId, userId: user.uid, role: "assistant", content: reply });
        after(() => recordExchange({ userId: user.uid, agentId: agent.id, conversationId, userMessage: body.message, assistantReply: reply, mode: "chat" }));
        return NextResponse.json({
          mode: "chat",
          conversationId,
          agentId: agent.id,
          classification,
          reply,
        });
      }

      // Réponse claire et simple : la charte pilote un appel LLM direct.
      if (classification.mode === "chat") {
        const reply = await answerAsAgent(agent, history.map((item) => ({ role: item.role, content: item.content })), body.message, fullNote);
        await appendMessage({ conversationId, userId: user.uid, role: "assistant", content: reply });
        after(() => recordExchange({ userId: user.uid, agentId: agent.id, conversationId, userMessage: body.message, assistantReply: reply, mode: "chat" }));
        if (agent.memoryEnabled && shouldSummarize(history.length + 2)) {
          after(() => summarizeConversation({
            userId: user.uid,
            agentId: agent.id,
            conversationId,
            history: [...history.map((item) => ({ role: item.role, content: item.content })), { role: "user", content: body.message }, { role: "assistant", content: reply }],
          }));
        }
        return NextResponse.json({
          mode: "chat",
          conversationId,
          agentId: agent.id,
          classification,
          reply,
        });
      }

      // Mode task : exécution concrète de la tâche, dans le périmètre de
      // l'agent (charte injectée dans le planificateur, outils restreints).
      const objectiveNote = fullNote ? `${fullNote}\n\n${body.message}` : body.message;
      const plan = await planAgentTask(user.uid, agent, objectiveNote);
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

        const waitingText = `J'ai préparé le plan d'exécution dans mon domaine (${classification.reason || "tâche confirmée"}). Une ou plusieurs actions externes nécessitent votre confirmation avant exécution.`;
        await appendMessage({ conversationId, userId: user.uid, role: "assistant", content: waitingText });

        return NextResponse.json({
          mode: "agent",
          status: "waiting_approval",
          executionId: plan.executionId,
          conversationId,
          agentId: agent.id,
          classification,
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
        projectId: agent.projectId,
        objective: body.message,
        plan,
        policy: policyForAgentPlan(agent, plan),
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

      let result;
      try {
        result = await runtime.run();
      } catch (error) {
        return NextResponse.json({
          mode: "agent",
          status: "failed",
          executionId: plan.executionId,
          conversationId,
          agentId: agent.id,
          classification,
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
      const taskReply = status === "waiting_approval"
        ? "J'ai exécuté les étapes autorisées. Une ou plusieurs actions nécessitent maintenant votre confirmation."
        : finalText;
      await appendMessage({
        conversationId,
        userId: user.uid,
        role: "assistant",
        content: taskReply,
      });
      after(() => recordExchange({ userId: user.uid, agentId: agent.id, conversationId, userMessage: body.message, assistantReply: taskReply, mode: "task" }));

      return NextResponse.json({
        mode: "agent",
        status,
        executionId: result.executionId,
        conversationId,
        agentId: agent.id,
        classification,
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
    }

    // ──────────────────────────────────────────────────────────────────
    // Chemin universel historique (compatibilité : flux existants).
    // ──────────────────────────────────────────────────────────────────
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
        content: "J'ai préparé le plan. Une ou plusieurs actions externes nécessitent votre confirmation avant que l'agent ne les exécute.",
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
        ? "J'ai préparé et exécuté les étapes autorisées. Une ou plusieurs actions nécessitent maintenant votre confirmation."
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
    const message = error instanceof Error ? error.message : "Agent request failed.";
    const upstream = message.includes("provider") || message.includes("planner") || message.includes("plan généré");
    return NextResponse.json(
      { error: upstream ? `${message}` : "Impossible de lancer la mission pour le moment. Réessayez." },
      { status: upstream ? 502 : 400 },
    );
  }
}

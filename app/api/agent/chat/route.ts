import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody } from "@/lib/security/http-errors";
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
import { describeConnectorsForPrompt, describeConnectedConnectorsForPrompt, type ConnectedConnectorsContext } from "@/lib/integrations/mention";
import { describeProjectServicesForPrompt, PROJECT_SERVICE_TOOLS } from "@/lib/agents/services/bridge";
import {
  extractImagePrompt,
  generateImageWithAgnes,
  ImageGenerationError,
  isImageGenerationEnabled,
  looksLikeImageRequest,
} from "@/lib/ai/image-generation";
import type { AgentRecord } from "@/lib/agents/schema";

const Body = z.object({
  message: z.string().trim().min(1).max(20_000),
  conversationId: z.string().trim().min(1).max(256).optional(),
  // Chat scopé à un agent personnalisé du Studio : classification,
  // périmètre strict et outils restreints.
  agentId: z.string().trim().min(1).max(128).optional(),
  attachmentPath: z.string().trim().min(1).max(500).optional(),
  attachmentName: z.string().trim().min(1).max(255).optional(),
  // Connecteurs activés par l'utilisateur via le sélecteur « @ » du chat :
  // l'agent reçoit le contexte des actions disponibles et peut agir dessus.
  activatedConnectors: z.array(
    z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,64}$/, "connecteur invalide"),
  ).max(10).optional(),
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

/** Intersection entre les outils requis par le plan et la whitelist de l'agent. */
function planPolicyForAgent(agent: AgentRecord, plan: RuntimePlan): ExecutionPolicy {
  const agentAllowed = new Set(policyForAgent(agent).allowedTools ?? []);
  const planPolicy = buildPolicy(plan);
  return {
    ...planPolicy,
    allowedTools: (planPolicy.allowedTools ?? []).filter((tool) => agentAllowed.has(tool)),
  };
}

/**
 * Politique effective d'une mission agent. Les connecteurs ouverts :
 *  - activés via « @ » (intentions explicites, même non connectés) ;
 *  - OU détectés automatiquement au statut « connecté » sur le compte.
 * Reste soumis aux approvals pour les actions à effet externe.
 */
function policyForAgentMission(agent: AgentRecord, plan: RuntimePlan, activatedConnectors: string[], connectedToolkits: string[] = []): ExecutionPolicy {
  const policy = planPolicyForAgent(agent, plan);
  // Les agents accèdent par défaut aux services du projet (documents,
  // fichiers, archives, recherche, mémoire, knowledge base, simulation) :
  // c'est ce qui leur permet d'EXÉCUTER les tâches, pas seulement répondre.
  const withServices = [...new Set([...(policy.allowedTools ?? []), ...PROJECT_SERVICE_TOOLS])];
  if (activatedConnectors.length === 0 && connectedToolkits.length === 0) {
    return { ...policy, allowedTools: withServices };
  }
  return {
    ...policy,
    allowedTools: [...new Set([...withServices, "composio.execute"])],
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

/**
 * Réponse d'un message demandant une image : génération RÉELLE via Agnes AI.
 * La conversation conserve le message utilisateur + la réponse (avec l'URL
 * de l'image) — l'UI affiche l'image au lieu d'une réponse textuelle.
 */
async function respondWithImage(params: {
  userId: string;
  conversationId: string;
  message: string;
  agentId?: string;
}): Promise<{ reply: string; imageUrl: string | undefined; model: string | undefined }> {
  const { userId, conversationId, message } = params;
  if (!isImageGenerationEnabled()) {
    const reply = "La génération d'images n'est pas encore disponible sur la plateforme. Réessayez bientôt.";
    await appendMessage({ conversationId, userId, role: "assistant", content: reply });
    return { reply, imageUrl: undefined, model: undefined };
  }
  try {
    const image = await generateImageWithAgnes({ prompt: extractImagePrompt(message) });
    const reply = "Voici l'image que j'ai générée pour vous.";
    await appendMessage({
      conversationId, userId, role: "assistant", content: reply,
      imageUrl: image.imageUrl, provider: "agnes", model: image.model,
    });
    return { reply, imageUrl: image.imageUrl, model: image.model };
  } catch (error) {
    const reply = error instanceof ImageGenerationError
      ? error.message
      : "La génération d'image a échoué. Réessayez dans un instant.";
    await appendMessage({ conversationId, userId, role: "assistant", content: reply });
    return { reply, imageUrl: undefined, model: undefined };
  }
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

    // Connecteurs connectés découverts AUTOMATIQUEMENT (statut « connecté ») :
    // les agents peuvent agir sur toutes les applications déjà autorisées,
    // sans activation manuelle « @ ». En parallèle de la classification pour
    // ne pas ajouter de latence au chemin nominal.
    const connectedPromise: Promise<ConnectedConnectorsContext> = describeConnectedConnectorsForPrompt(user.uid).catch(
      (): ConnectedConnectorsContext => ({ toolkits: [] }),
    );

    if (agent) {
      // ────────────────────────────────────────────────────────────────
      // Chemin agent personnalisé : classification → réponse/refus/exécution.
      // ────────────────────────────────────────────────────────────────
      await appendMessage({
        conversationId,
        userId: user.uid,
        role: "user",
        content: body.message,
      });

      // Génération d'images réelle (Agnes AI) : une demande explicite d'image
      // est servie directement, quel que soit le type d'agent — c'est une
      // capacité de la plateforme, pas du LLM conversationnel.
      if (looksLikeImageRequest(body.message)) {
        const imageResult = await respondWithImage({
          userId: user.uid,
          conversationId,
          message: body.message,
          agentId: agent.id,
        });
        after(() => recordExchange({ userId: user.uid, agentId: agent.id, conversationId, userMessage: body.message, assistantReply: imageResult.reply, mode: "chat" }));
        return NextResponse.json({
          mode: "chat",
          conversationId,
          agentId: agent.id,
          classification: { mode: "chat" as const, inScope: true, reason: "Génération d'image" },
          reply: imageResult.reply,
          imageUrl: imageResult.imageUrl,
        });
      }

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
      // Connecteurs : TOUT ce qui est au statut « connecté » est disponible
      // automatiquement ; le sélecteur « @ » reste prioritaire (intentions
      // explicites, y compris pour un toolkit pas encore connecté).
      const connected = await connectedPromise;
      const activatedConnectors = body.activatedConnectors ?? [];
      const extraActivated = activatedConnectors.filter((toolkit) => !connected.toolkits.includes(toolkit));
      const connectorsNote = [
        connected.note,
        extraActivated.length > 0 ? await describeConnectorsForPrompt(user.uid, extraActivated) : undefined,
      ].filter(Boolean).join("\n\n") || undefined;
      // Services du projet : catalogue injecté pour que le planificateur
      // sache quels services (documents, fichiers, recherche, mémoire…)
      // sont utilisables et comment les nommer.
      const servicesNote = describeProjectServicesForPrompt();
      const fullNote = [note, memoryNote, mcpNote, connectorsNote, servicesNote].filter(Boolean).join("\n\n") || undefined;

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
        policy: policyForAgentMission(agent, plan, activatedConnectors, connected.toolkits),
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

    // Génération d'images réelle (Agnes AI) sur le chemin universel aussi.
    if (looksLikeImageRequest(body.message)) {
      const imageResult = await respondWithImage({
        userId: user.uid,
        conversationId,
        message: body.message,
      });
      return NextResponse.json({
        mode: "chat",
        status: "completed",
        conversationId,
        objective: body.message,
        reply: imageResult.reply,
        imageUrl: imageResult.imageUrl,
      });
    }

    // Connecteurs connectés : contexte injecté + composio.execute ouvert,
    // comme sur le chemin agent personnalisé.
    const connectedUniversal = await connectedPromise;
    const universalObjective = connectedUniversal.note
      ? `${connectedUniversal.note}\n\n${body.message}`
      : body.message;

    const plan = await planUniversalAgent(user.uid, universalObjective);
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
      policy: {
        ...buildPolicy(plan),
        allowedTools: connectedUniversal.toolkits.length > 0
          ? [...new Set([...(buildPolicy(plan).allowedTools ?? []), "composio.execute"])]
          : buildPolicy(plan).allowedTools,
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
    // Erreur structurée : un code machine (PROVIDER_UNAVAILABLE, INTERNAL…)
    // permet à l'UI d'afficher l'état réel (réessayer vs réconnecter) au lieu
    // de deviner à partir du message.
    const body = errorBody(error, "Agent request failed.");
    const upstream = body.code === "PROVIDER_UNAVAILABLE"
      || body.error.includes("provider")
      || body.error.includes("planner")
      || body.error.includes("plan généré");
    return NextResponse.json(
      { error: upstream ? body.error : "Impossible de lancer la mission pour le moment. Réessayez.", code: body.code },
      { status: upstream ? 502 : 400 },
    );
  }
}

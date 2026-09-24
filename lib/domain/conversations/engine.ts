import { z } from "zod";

import { runAI, runAIJSON } from "@/lib/engines/ai-engine";
import { generate, generateStream } from "@/lib/ai/router";
import {
  enhanceImagePrompt,
  generateImageWithAgnes,
  ImageGenerationError,
  looksLikeImageRequest,
} from "@/lib/ai/image-generation";
import type { ToolRisk } from "@/lib/tools/types";
import { createDefaultToolRegistry } from "@/lib/tools/default-registry";
import { executeTool } from "@/lib/tools/executor";
import type { ExecutionPolicy } from "@/lib/security/execution-policy";

import {
  appendMessage,
  getConversation,
  listMessages,
  type ChatConversation,
  type ChatMessage,
} from "@/lib/chat/repository";
import { getProject, type WorkspaceProject } from "@/lib/domain/projects/repository";
import {
  createRun,
  finalizeRun,
  makeStep,
  updateRunSteps,
} from "@/lib/domain/runs/repository";
import { createApproval } from "@/lib/domain/approvals/repository";
import { createArtifact } from "@/lib/domain/artifacts/repository";
import type {
  ConversationApproval,
  ConversationArtifact,
  ConversationMessage,
  ConversationRun,
  MessageAttachment,
  RunStep,
} from "./types";
import { safeEmitter, type StreamEventEmitter } from "./stream-events";

/**
 * Moteur conversationnel — chaque tour de conversation peut être :
 *  - une réponse directe (chat) ;
 *  - une demande d'image (génération réelle Agnes AI) ;
 *  - un PLAN d'exécution : compréhension → plan → outils → approbation →
 *    exécution → résultat/artefacts, avec validations humaines inline.
 *
 * Aucun outil sensible ne s'exécute sans une Approval explicite : les étapes
 * à risque (high/critical) sont mises en attente (« awaiting ») et une carte
 * de validation est créée dans la conversation.
 */

/* ------------------------------------------------------------------ */
/* Catalogue d'outils disponible dans les conversations                */
/* ------------------------------------------------------------------ */

/** Outils exclus du catalogue conversationnel (surfaces spécialisées). */
const EXCLUDED_TOOLS = new Set(["camera.capture", "code.execute", "ui.components"]);

const registry = createDefaultToolRegistry();

export interface ToolCatalogEntry {
  name: string;
  description: string;
  risk: ToolRisk;
  requiresApproval: boolean;
}

export function conversationToolCatalog(): ToolCatalogEntry[] {
  return registry
    .list()
    .filter((tool) => !EXCLUDED_TOOLS.has(tool.id ?? tool.name))
    .map((tool) => ({
      name: tool.id ?? tool.name,
      description: tool.description,
      risk: tool.risk,
      requiresApproval: stepRequiresApproval(tool.risk),
    }));
}

/* ------------------------------------------------------------------ */
/* Politique d'exécution des étapes de conversation                    */
/* ------------------------------------------------------------------ */

/**
 * Politique dédiée aux conversations : réseaux et applications externes
 * autorisés (l'utilisateur les déclenche explicitement), mais ni code
 * arbitraire, ni terminal, ni caméra dans ce contexte.
 */
export const CONVERSATION_EXECUTION_POLICY: ExecutionPolicy = {
  // "*" : le filtrage réel est fait en amont (catalogue conversationnel sans
  // code.execute/camera.capture, plan validé par l'IA d'intention, et
  // validations humaines pour les risques high/critical). Les permissions
  // ci-dessous restent la barrière fine de chaque outil.
  allowedTools: ["*"],
  permissions: [
    "tool.read", "tool.write", "tool.external",
    "file.read", "file.write", "file.create",
    "network.read", "network.write",
    "memory.read", "memory.write",
    "ads.read",
  ],
  maxSteps: 10,
  maxExecutionMs: 4 * 60 * 1000,
  maxToolExecutionMs: 90 * 1000,
  maxOutputBytes: 2 * 1024 * 1024,
  maxInputBytes: 256 * 1024,
  allowNetwork: true,
  allowExternalApps: true,
  allowFileWrite: true,
  allowFileDelete: false,
  allowCodeExecution: false,
  allowAgentTerminal: false,
  allowCamera: false,
};

/** Risques exigeant une validation humaine avant exécution. */
const APPROVAL_RISKS: ReadonlySet<ToolRisk> = new Set(["high", "critical"]);

export function stepRequiresApproval(risk: string): boolean {
  return APPROVAL_RISKS.has(risk as ToolRisk);
}

/** Coût estimé affiché sur la carte de validation. */
export function estimatedCostForTool(toolName: string): string {
  if (toolName.startsWith("web.") || toolName.startsWith("knowledge.")) return "gratuit";
  if (toolName.startsWith("voice.")) return "~0,02 € / génération";
  if (toolName === "phone.call") return "selon destination (~0,02 €/min)";
  if (toolName.startsWith("composio.") || toolName.startsWith("mcp.")) return "inclus (application connectée)";
  return "gratuit";
}

/** Périmètre de données lisible affiché sur la carte de validation. */
export function dataScopeForTool(toolName: string, input: unknown): string {
  const target =
    input && typeof input === "object" && "toolkit" in (input as Record<string, unknown>)
      ? String((input as Record<string, unknown>).toolkit)
      : undefined;
  if (toolName === "composio.execute") return `Application connectée${target ? ` « ${target} »` : ""} — action externe`;
  if (toolName === "mcp.call") return "Serveurs MCP connectés (Drive, GitHub, bases de données…)";
  if (toolName === "email.send") return "Destinataire du message + signature plateforme";
  if (toolName === "messaging.send") return "Canal de messagerie connecté (WhatsApp, Telegram, Slack)";
  if (toolName === "social.publish") return "Compte social connecté — publication publique";
  if (toolName === "webhook.emit") return "Endpoints webhook déclarés par votre compte";
  if (toolName === "github.create_repository") return "Votre compte GitHub — nouveau dépôt";
  if (toolName === "phone.call") return "Numéro appelé + transcript de l'appel";
  if (toolName === "file.create" || toolName === "artifact.create") return "Votre stockage permanent Gen3ia";
  if (toolName === "memory.write") return "Mémoire permanente de vos agents";
  if (toolName.startsWith("cloudflare.")) return "Zones DNS Cloudflare autorisées";
  if (toolName.startsWith("notion.")) return "Espace Notion autorisé";
  return "Données transmises dans la demande";
}

/* ------------------------------------------------------------------ */
/* Condensation des sorties d'outils                                   */
/* ------------------------------------------------------------------ */

/** Sortie condensée, lisible, stockée dans la timeline (≈ 1 200 car.). */
export function condenseToolOutput(output: unknown): string {
  let text: string;
  if (output === undefined || output === null) text = "";
  else if (typeof output === "string") text = output;
  else {
    try {
      text = JSON.stringify(output, null, 2);
    } catch {
      text = String(output);
    }
  }
  text = text.replace(/\s+\n/g, "\n").trim();
  if (text.length <= 1200) return text;
  return `${text.slice(0, 1170)}\n… (sortie tronquée, ${text.length - 1170} caractères restants)`;
}

/* ------------------------------------------------------------------ */
/* Décision d'intention : chat direct ou plan d'exécution              */
/* ------------------------------------------------------------------ */

const IntentStepSchema = z.object({
  title: z.string().min(1).max(200),
  detail: z.string().max(1500).optional(),
  toolName: z.string().trim().max(80).optional(),
  toolInput: z.record(z.string(), z.unknown()).optional(),
  sensitive: z.boolean().optional(),
});

const IntentSchema = z.object({
  mode: z.enum(["chat", "plan"]),
  understanding: z.string().max(1200).describe("Compréhension de la demande en une phrase"),
  reply: z.string().max(18000).optional().describe("Réponse directe si mode=chat"),
  objective: z.string().max(1000).optional().describe("Objectif du plan si mode=plan"),
  steps: z.array(IntentStepSchema).max(8).optional(),
});

export type TurnIntent = z.infer<typeof IntentSchema>;

/**
 * Garde-fou déterministe : certaines demandes énoncent EXPLICITEMENT l'outil
 * attendu (« fais une recherche web… »). Si l'IA classe malgré tout la demande
 * en simple réponse (ou si sa décision est indisponible), cette heuristique
 * force un plan avec l'outil réel — la demande de l'utilisateur est loi.
 */
export function detectExplicitToolIntent(message: string, catalog: ToolCatalogEntry[]): { toolName: string; query: string } | null {
  const lower = message.toLowerCase();
  const catalogNames = new Set(catalog.map((t) => t.name));
  const webMarkers = /(recherche[s]? (web|internet)|cherche[rz]? (sur )?(le |la )?(web|internet)|fais[ez]? une recherche|search (the )?web|web search|sur (le|internet))\b/i;
  if (webMarkers.test(lower) && catalogNames.has("web.search")) {
    return { toolName: "web.search", query: message.slice(0, 400) };
  }
  const imageMarkers = /\b(g[eé]n[eè]re|cr[eé]e|dessine)\b.*\b(image|illustration|dessin|visuel)\b|\b(image|illustration)\b.*\b(g[eé]n[eè]r)\b/i;
  if (imageMarkers.test(lower) && catalogNames.has("artifact.create")) {
    // Les images sont traitées en amont par Agnes ; ici on ne force rien.
    return null;
  }
  return null;
}

/** Requête condensée pour l'outil de recherche (nettoyage des formules). */
export function extractSearchQuery(message: string): string {
  const cleaned = message
    .replace(/^(fais[ez]?|peux[- ]tu|pourrais[- ]tu|merci de|stp|s'il te pla[eî]t)\s+/i, "")
    .replace(/(une |la |de )?(recherche[s]? (web|internet|sur internet)|search)\s*(sur|about|for)?\s*/i, "")
    .replace(/^(sur |about )+/i, "")
    .replace(/\s+et r[eé]sume[- ].*$/i, "")
    // Séparateurs résiduels après suppression de la formule (" : ", " - "…).
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim()
    .slice(0, 300);
  return cleaned || message.replace(/^[^\p{L}\p{N}]+/u, "").trim().slice(0, 300) || message.slice(0, 300);
}

export function buildIntentSystemPrompt(
  catalog: ToolCatalogEntry[],
  project?: WorkspaceProject | null,
  connectors?: string[],
): string {
  const toolLines = catalog
    .map((t) => `- ${t.name} (risque ${t.risk}${t.requiresApproval ? ", validation requise" : ""}) : ${t.description}`)
    .join("\n");
  const connectorSection = connectors && connectors.length > 0
    ? [
        "",
        `Connecteurs activés explicitement par l'utilisateur pour CETTE demande : ${connectors.join(", ")}.`,
        "Si la demande concerne ces services, utilise l'outil composio.execute avec input { toolkit: \"<slug>\", action: \"<action>\", params: { … } }.",
        "Les actions externes (envoi, publication, modification) sont sensibles : décris leur impact précisément, la validation humaine sera demandée.",
      ].join("\n")
    : "";
  return [
    "Tu es le moteur d'exécution de Gen3ia, une plateforme d'agents avec connecteurs.",
    "La conversation complète est une source de contexte : utilise l'historique récent pour résoudre les pronoms, les références implicites et les contraintes déjà données. Si une information manque ou est incertaine, dis-le clairement et pose une seule question ciblée au lieu d'inventer.",
    "Ne révèle pas ton raisonnement interne, les étapes techniques ou les outils dans la réponse finale sauf si l'utilisateur les demande explicitement. Retourne uniquement le résultat demandé, avec les citations ou limites nécessaires.",
    "Pour chaque demande utilisateur, tu décides :",
    '  mode="chat" : la demande se traite par une simple réponse textuelle (question, explication, rédaction courte). Remplis alors `reply`.',
    '  mode="plan" : la demande exige des actions réelles (recherche, fichiers, applications connectées, publication…). Remplis alors `objective` et 1 à 8 `steps`.',
    "Chaque step avec un toolName doit utiliser EXACTEMENT un des outils du catalogue ci-dessous, avec toolInput conforme à sa description.",
    "Un step sans toolName est une étape de raisonnement/rédaction exécutée par toi-même.",
    "Les outils marqués « validation requise » ne seront exécutés qu'après approbation explicite de l'utilisateur : décris leur impact précisément dans detail.",
    "Ne propose jamais un outil qui n'est pas dans le catalogue. Ne fabrique pas d'identifiants, de tokens ou de numéros.",
    "",
    "Catalogue d'outils disponibles :",
    toolLines,
    "",
    project?.instructions ? `Instructions persistantes du projet « ${project.name} » (à respecter) :\n${project.instructions}` : "",
    project?.privacyRules ? `Règles de confidentialité du projet (impératives) :\n${project.privacyRules}` : "",
    connectorSection,
    "Réponds UNIQUEMENT avec l'objet JSON conforme au schéma.",
  ]
    .filter(Boolean)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Tour de conversation                                                */
/* ------------------------------------------------------------------ */

export interface ConversationTurnInput {
  userId: string;
  conversationId: string;
  message: string;
  attachments?: MessageAttachment[];
  projectId?: string;
  provider?: string;
  model?: string;
  /** Connecteurs activés explicitement pour ce tour (slugs Composio). */
  connectors?: string[];
  /** Émetteur d'événements de flux (streaming NDJSON) — absent = API classique. */
  onEvent?: StreamEventEmitter;
}

export interface ConversationTurnResult {
  conversationId: string;
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
  run?: ConversationRun;
  artifacts: ConversationArtifact[];
  approvals: ConversationApproval[];
  intent: TurnIntent;
}

function historyForModel(history: ChatMessage[], limit = 24) {
  return history.slice(-limit).map((m) => ({ role: m.role, content: m.content.slice(0, 12000) }));
}

/**
 * Budget temps par appel IA : la fonction serverless a 60 s (plan Hobby).
 * Chaque étape IA reçoit un délai ferme, avec replis prévus — la fonction
 * rend toujours la main sous le plafond, jamais de 504 opaque.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Délai dépassé (${label})`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

const INTENT_BUDGET_MS = 25_000;
const CHAT_BUDGET_MS = 35_000;
const SUMMARY_BUDGET_MS = 15_000;

/** Contexte des pièces jointes injecté au modèle. */
function attachmentsContext(attachments?: MessageAttachment[]): string {
  if (!attachments || attachments.length === 0) return "";
  const lines = attachments.map((a) => `- ${a.filename}${a.contentType ? ` (${a.contentType})` : ""}`);
  return `\n\nPièces jointes de l'utilisateur :\n${lines.join("\n")}`;
}

export async function runConversationTurn(input: ConversationTurnInput): Promise<ConversationTurnResult> {
  // L'émetteur est enveloppé : une erreur de flux (client déconnecté…) ne
  // doit jamais interrompre le tour ni la persistance serveur.
  const onEvent = safeEmitter(input.onEvent);
  const conversation: ChatConversation | null = await getConversation(input.userId, input.conversationId);
  if (!conversation) throw new Error("Conversation introuvable.");

  const projectId = input.projectId ?? conversation.projectId;
  const project = projectId ? await getProject(input.userId, projectId) : null;
  if (projectId && !project) throw new Error("Projet introuvable pour cette conversation.");

  // 1) Message utilisateur persisté (pièces jointes + connecteurs inclus).
  const userMessage = await appendMessage({
    conversationId: input.conversationId,
    userId: input.userId,
    role: "user",
    content: input.message,
    attachments: input.attachments,
    connectors: input.connectors,
    generationStatus: "complete",
  });
  await onEvent({ type: "turn_started", conversationId: input.conversationId, userMessage });

  const history = await listMessages(input.userId, input.conversationId, 100);
  const priorHistory = history.slice(0, -1);

  // 2) Demande d'image : g��nération réelle (Agnes AI) + artefact image.
  if (looksLikeImageRequest(input.message)) {
    await onEvent({ type: "status", phase: "image", label: "Génération de l'image en cours…" });
    const result = await runImageTurn({ ...input, conversation, project, projectId, userMessage, priorHistory });
    await onEvent({
      type: "done",
      assistantMessage: result.assistantMessage,
      artifacts: result.artifacts,
      approvals: result.approvals,
    });
    return result;
  }

  // 3) Décision d'intention structurée — tâche de classification simple :
  // routée sur les modèles "chat" (rapides) pour rester sous le budget de
  // latence de la fonction serverless.
  const catalog = conversationToolCatalog();
  await onEvent({ type: "status", phase: "intention", label: "Analyse de votre demande…" });
  let intent: TurnIntent;
  try {
    const result = await withTimeout(
      runAIJSON({
        userId: input.userId,
        feature: "conversation-turn",
        task: "chat",
        system: buildIntentSystemPrompt(catalog, project, input.connectors),
        prompt:
          `Historique récent :\n${priorHistory.slice(-6).map((m) => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content.slice(0, 500)}`).join("\n") || "(vide)"}` +
          `\n\nNouvelle demande : ${input.message.slice(0, 4000)}${attachmentsContext(input.attachments)}`,
        schema: IntentSchema,
        label: "intention-conversation",
        maxTokens: 2500,
      }),
      INTENT_BUDGET_MS,
      "décision d'intention",
    );
    intent = result.data;
  } catch {
    // Décision indisponible : repli sûr = réponse conversationnelle simple.
    intent = { mode: "chat", understanding: "Réponse directe (planification indisponible)." };
  }

  if (intent.mode === "chat") {
    // Garde-fou : la demande exige explicitement un outil réel ?
    const explicit = detectExplicitToolIntent(input.message, catalog);
    if (explicit) {
      intent = {
        mode: "plan",
        understanding: "Demande explicite d'actions réelles (recherche web).",
        objective: input.message.slice(0, 400),
        steps: [
          {
            title: "Recherche web",
            detail: "Recherche réelle sur le web demandée explicitement par l'utilisateur.",
            toolName: explicit.toolName,
            toolInput: { query: extractSearchQuery(input.message), maxResults: 8 },
          },
        ],
      };
    }
  }
  if (intent.mode === "chat") {
    const result = await runChatTurn({ ...input, conversation, project, projectId, userMessage, priorHistory, intent });
    await onEvent({
      type: "done",
      assistantMessage: result.assistantMessage,
      artifacts: result.artifacts,
      approvals: result.approvals,
    });
    return result;
  }
  const result = await runPlanTurn({ ...input, conversation, project, projectId, userMessage, priorHistory, intent });
  await onEvent({
    type: "done",
    assistantMessage: result.assistantMessage,
    run: result.run,
    artifacts: result.artifacts,
    approvals: result.approvals,
  });
  return result;
}

/* ------------------------------------------------------------------ */
/* Tour « chat » — réponse directe                                     */
/* ------------------------------------------------------------------ */

interface TurnBase extends ConversationTurnInput {
  conversation: ChatConversation;
  project: WorkspaceProject | null;
  userMessage: ConversationMessage;
  priorHistory: ChatMessage[];
}

interface TurnContext extends TurnBase {
  intent: TurnIntent;
}

async function runChatTurn(ctx: TurnContext): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  const streaming = Boolean(ctx.onEvent);
  const systemParts = [
    "Tu es Gen3ia, l'assistant de travail qui exécute : tu réponds de façon directe, structurée et actionnable.",
    ctx.project?.instructions ? `Instructions du projet « ${ctx.project.name} » :\n${ctx.project.instructions}` : "",
    ctx.project?.privacyRules ? `Règles de confidentialité impératives :\n${ctx.project.privacyRules}` : "",
  ].filter(Boolean);

  const requestMessages = [
    ...(systemParts.length > 0
      ? [{ role: "system" as const, content: systemParts.join("\n\n") }]
      : []),
    ...historyForModel(ctx.priorHistory),
    { role: "user" as const, content: ctx.message },
  ];

  let content: string;
  let provider: string | undefined;
  let model: string | undefined;
  let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
  let generationStatus: "complete" | "failed" = "complete";

  if (streaming) {
    // Streaming réel : chaque fragment est transmis au client au fil de
    // l'arrivée ; le texte complet est ensuite persisté d'un bloc.
    await onEvent({ type: "status", phase: "synthesis", label: "L'assistant rédige sa réponse…" });
    let streamedText = "";
    try {
      const response = await withTimeout(
        generateStream(
          {
            task: "chat",
            messages: requestMessages,
            provider: ctx.provider as never,
            model: ctx.model,
            preferFree: true,
            metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
          },
          {
            onDelta: (delta) => {
              streamedText += delta;
              return onEvent({ type: "message_delta", delta });
            },
          },
        ),
        CHAT_BUDGET_MS,
        "réponse conversationnelle",
      );
      content = response.text;
      provider = response.provider;
      model = response.model;
      usage = response.usage;
    } catch (error) {
      if (streamedText.length > 0) {
        // Flux interrompu en cours de route : le texte partiel déjà affiché
        // est conservé et complété d'une note honnête — jamais de texte perdu.
        content =
          `${streamedText}\n\n_(réponse interrompue — renvoyez votre message pour une réponse complète)_`;
        provider = "gen3ia";
        generationStatus = "failed";
        console.error("[conversation] flux interrompu en cours:", error instanceof Error ? error.message : error);
      } else {
        // Aucun fournisseur n'a pu démarrer : repli sur la réponse classique
        // (sans duplication de texte, rien n'a encore été émis côté client).
        try {
          const response = await withTimeout(
            generate({
              task: "chat",
              messages: requestMessages,
              provider: ctx.provider as never,
              model: ctx.model,
              preferFree: true,
              metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
            }),
            CHAT_BUDGET_MS,
            "réponse conversationnelle",
          );
          content = response.text;
          provider = response.provider;
          model = response.model;
          usage = response.usage;
          await onEvent({ type: "message_delta", delta: content });
        } catch (fallbackError) {
          content =
            "Je n'ai pas réussi à produire une réponse dans le délai imparti (le fournisseur IA est surchargé). " +
            "Réessayez en renvoyant votre message — il reste dans la conversation.";
          provider = "gen3ia";
          generationStatus = "failed";
          console.error("[conversation] échec réponse chat:", fallbackError instanceof Error ? fallbackError.message : fallbackError);
        }
      }
    }
  } else {
    try {
      const response = await withTimeout(
        generate({
          task: "chat",
          messages: requestMessages,
          provider: ctx.provider as never,
          model: ctx.model,
          preferFree: true,
          metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
        }),
        CHAT_BUDGET_MS,
        "réponse conversationnelle",
      );
      content = response.text;
      provider = response.provider;
      model = response.model;
      usage = response.usage;
    } catch (error) {
      // Échec/timeout IA : réponse honnête persistée dans le fil (jamais de 504
      // opaque), l'utilisateur peut renvoyer le message.
      content =
        "Je n'ai pas réussi à produire une réponse dans le délai imparti (le fournisseur IA est surchargé). " +
        "Réessayez en renvoyant votre message — il reste dans la conversation.";
      provider = "gen3ia";
      generationStatus = "failed";
      console.error("[conversation] échec réponse chat:", error instanceof Error ? error.message : error);
    }
  }

  const assistantMessage = await appendMessage({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    role: "assistant",
    content,
    provider,
    model,
    generationStatus,
    usage,
  });
  await onEvent({ type: "message_complete", message: assistantMessage });

  return {
    conversationId: ctx.conversationId,
    userMessage: ctx.userMessage,
    assistantMessage,
    artifacts: [],
    approvals: [],
    intent: ctx.intent,
  };
}

/* ------------------------------------------------------------------ */
/* Tour « image » — génération réelle + artefact                       */
/* ------------------------------------------------------------------ */

async function runImageTurn(ctx: TurnBase): Promise<ConversationTurnResult> {
  try {
    const image = await generateImageWithAgnes({ prompt: enhanceImagePrompt(ctx.message) });
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: "Voici l'image que j'ai générée pour vous. Elle est également enregistrée dans les artefacts de la conversation.",
      imageUrl: image.imageUrl,
      provider: "agnes",
      model: image.model,
      generationStatus: "complete",
    });
    const artifact = await createArtifact({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      type: "image",
      title: ctx.message.slice(0, 80),
      url: image.imageUrl,
      note: `Généré avec ${image.model}`,
    });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [artifact],
      approvals: [],
      intent: { mode: "chat", understanding: "Demande de génération d'image." },
    };
  } catch (error) {
    const message = error instanceof ImageGenerationError
      ? error.message
      : "La génération d'image a échoué. Réessayez dans un instant.";
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: message,
      generationStatus: "failed",
    });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Demande de génération d'image." },
    };
  }
}

/* ------------------------------------------------------------------ */
/* Tour « plan » — timeline, outils, approbations, artefacts           */
/* ------------------------------------------------------------------ */

const TOOL_OUTPUT_ARTIFACTS: ReadonlySet<string> = new Set(["artifact.create", "file.create", "zip.create"]);

async function runPlanTurn(ctx: TurnContext): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  const streaming = Boolean(ctx.onEvent);
  const catalog = conversationToolCatalog();
  const catalogByName = new Map(catalog.map((t) => [t.name, t]));
  const plannedSteps = (ctx.intent.steps ?? []).slice(0, 8);

  const steps: RunStep[] = [
    makeStep({
      phase: "understanding",
      title: "Compréhension de la demande",
      detail: ctx.intent.understanding,
      status: "done",
    }),
    makeStep({
      phase: "plan",
      title: ctx.intent.objective?.slice(0, 200) || "Plan proposé",
      detail: plannedSteps.map((s, i) => `${i + 1}. ${s.title}`).join("\n") || "Exécution directe.",
      status: "done",
    }),
  ];

  const approvals: ConversationApproval[] = [];
  const artifacts: ConversationArtifact[] = [];

  const run = await createRun({
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    projectId: ctx.projectId,
    objective: ctx.intent.objective || ctx.message.slice(0, 500),
    steps,
  });
  await onEvent({ type: "run_created", run: { ...run, status: "running", steps } });
  await onEvent({ type: "status", phase: "execution", label: "Exécution du plan en cours…" });

  let executedSomething = false;
  let anyFailure = false;

  for (const planned of plannedSteps) {
    const toolEntry = planned.toolName ? catalogByName.get(planned.toolName) : undefined;
    if (planned.toolName && !toolEntry) {
      const step = makeStep({
        phase: "tools",
        title: planned.title,
        detail: `Outil demandé introuvable dans le catalogue : ${planned.toolName}`,
        status: "skipped",
      });
      steps.push(step);
      await onEvent({ type: "step_update", runId: run.id, step });
      continue;
    }

    const toolName = planned.toolName ?? undefined;
    const risk = toolEntry?.risk ?? "low";
    const sensitive = planned.sensitive === true || (toolName ? stepRequiresApproval(risk) : false);

    if (toolName && sensitive) {
      // Approbation inline : l'étape reste en attente, un outil de contrôle
      // humain est créé avec impact, périmètre de données et coût estimé.
      const step = makeStep({
        phase: "approval",
        title: planned.title,
        detail: planned.detail ?? toolEntry?.description,
        toolName,
        toolInput: planned.toolInput,
        status: "awaiting",
      });
      steps.push(step);
      await onEvent({ type: "step_update", runId: run.id, step });
      const approval = await createApproval({
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        runId: run.id,
        stepId: step.id,
        toolName,
        title: planned.title,
        impact: planned.detail ?? toolEntry?.description ?? planned.title,
        dataScope: dataScopeForTool(toolName, planned.toolInput),
        estimatedCost: estimatedCostForTool(toolName),
        risk,
      });
      approvals.push(approval);
      await onEvent({ type: "approval_created", approval });
      continue;
    }

    // Étape exécutable immédiatement.
    const step = makeStep({
      phase: toolName ? "execution" : "result",
      title: planned.title,
      detail: planned.detail,
      toolName,
      toolInput: planned.toolInput,
      status: "in_progress",
    });
    steps.push(step);
    await onEvent({ type: "step_update", runId: run.id, step });

    if (toolName) {
      const startedAt = new Date().toISOString();
      const result = await executeTool({
        userId: ctx.userId,
        executionId: run.id,
        projectId: ctx.projectId,
        toolName,
        input: planned.toolInput ?? {},
        policy: CONVERSATION_EXECUTION_POLICY,
      });
      step.startedAt = startedAt;
      step.finishedAt = new Date().toISOString();
      if (result.success) {
        step.status = "done";
        step.output = condenseToolOutput(result.output);
        executedSomething = true;
        if (TOOL_OUTPUT_ARTIFACTS.has(toolName)) {
          const artifact = await artifactFromToolOutput({
            userId: ctx.userId,
            conversationId: ctx.conversationId,
            projectId: ctx.projectId,
            runId: run.id,
            toolName,
            toolInput: planned.toolInput ?? {},
            output: result.output,
          });
          if (artifact) {
            artifacts.push(artifact);
            step.artifactId = artifact.id;
            await onEvent({ type: "artifact_created", artifact });
          }
        }
      } else {
        step.status = "failed";
        step.output = result.error;
        anyFailure = true;
      }
      await onEvent({ type: "step_update", runId: run.id, step });
    } else {
      // Étape de rédaction : traitée par le modèle à la synthèse finale.
      step.status = "done";
      step.finishedAt = new Date().toISOString();
      await onEvent({ type: "step_update", runId: run.id, step });
    }
  }

  // 4) Statut final du run : en attente de validations, terminé, ou échec partiel.
  const hasPending = approvals.length > 0;
  const runStatus = hasPending
    ? ("awaiting_approval" as const)
    : anyFailure && !executedSomething
      ? ("failed" as const)
      : ("completed" as const);
  const resultStep = makeStep({
    phase: "result",
    title: hasPending ? "En attente de votre validation" : "Résultat",
    detail: hasPending
      ? `${approvals.length} action(s) sensible(s) attend(ent) votre approbation ci-dessous.`
      : `${steps.filter((s) => s.status === "done").length} étape(s) réalisée(s).`,
    status: "done",
  });
  steps.push(resultStep);
  await onEvent({ type: "step_update", runId: run.id, step: resultStep });
  await onEvent({ type: "run_status", runId: run.id, status: hasPending ? "awaiting_approval" : runStatus });

  // 5) Synthèse finale de l'assistant (en flux quand le client suit le tour).
  await onEvent({ type: "status", phase: "synthesis", label: "Rédaction du résultat…" });
  const summary = await summarizePlanTurn(ctx, run, steps, artifacts, approvals, hasPending, streaming ? (delta) => onEvent({ type: "message_delta", delta }) : undefined);

  if (hasPending) {
    await updateRunSteps(ctx.userId, run.id, steps);
  } else {
    await finalizeRun(ctx.userId, run.id, runStatus, steps);
  }

  const assistantMessage = await appendMessage({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    role: "assistant",
    content: summary,
    runId: run.id,
    generationStatus: "complete",
  });
  await onEvent({ type: "message_complete", message: assistantMessage });

  return {
    conversationId: ctx.conversationId,
    userMessage: ctx.userMessage,
    assistantMessage,
    run: { ...run, status: runStatus, steps },
    artifacts,
    approvals,
    intent: ctx.intent,
  };
}

/** Synthèse lisible du tour de plan (modèle, avec repli déterministe). */
async function summarizePlanTurn(
  ctx: TurnContext,
  run: ConversationRun,
  steps: RunStep[],
  artifacts: ConversationArtifact[],
  approvals: ConversationApproval[],
  hasPending: boolean,
  onDelta?: (delta: string) => Promise<void> | void,
): Promise<string> {
  const deterministic = [
    `**${run.objective}**`,
    "",
    steps
      .filter((s) => s.phase !== "understanding" && s.phase !== "plan")
      .map((s) => {
        const mark = s.status === "done" ? "✓" : s.status === "awaiting" ? "⏸" : s.status === "failed" ? "✕" : "·";
        return `${mark} ${s.title}${s.output ? ` — ${s.output.slice(0, 300)}` : ""}`;
      })
      .join("\n"),
    artifacts.length > 0 ? `\nArtefacts produits : ${artifacts.map((a) => a.title).join(", ")}.` : "",
    hasPending ? "\n⚠️ Des actions sensibles attendent votre validation avant exécution." : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const request = {
      task: "chat" as const,
      messages: [
        {
          role: "system" as const,
          content:
            "Tu synthétises le résultat d'un plan d'exécution pour l'utilisateur de Gen3ia. " +
            "Style : concis, factuel, orienté résultat. Mentionne les artefacts créés et, s'il y en a, " +
            "les actions sensibles qui attendent sa validation. Pas de markdown de titre (#).",
        },
        {
          role: "user" as const,
          content:
            `Demande : ${ctx.message.slice(0, 1000)}\nObjectif du plan : ${run.objective}\n` +
            `Étapes :\n${steps.map((s) => `- [${s.status}] ${s.title}${s.output ? ` : ${s.output.slice(0, 400)}` : ""}`).join("\n")}\n` +
            `Artefacts : ${artifacts.map((a) => `${a.title} (${a.type})`).join(", ") || "aucun"}\n` +
            `Validations en attente : ${approvals.map((a) => `${a.title} — impact : ${a.impact}`).join(" ; ") || "aucune"}`,
        },
      ],
      preferFree: true,
      maxTokens: 700,
      metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
    };
    if (onDelta) {
      // Synthèse en flux : les fragments rejoignent le fil en direct.
      const response = await withTimeout(
        generateStream(request, { onDelta }),
        SUMMARY_BUDGET_MS,
        "synthèse du plan",
      );
      return response.text || deterministic;
    }
    const response = await withTimeout(generate(request), SUMMARY_BUDGET_MS, "synthèse du plan");
    return response.text || deterministic;
  } catch {
    // Synthèse indisponible (ou flux interrompu) : le repli déterministe est
    // renvoyé d'un bloc — le client remplace le texte en cours par la version
    // finale au moment de message_complete.
    return deterministic;
  }
}

/* ------------------------------------------------------------------ */
/* Artefact issu d'une sortie d'outil                                  */
/* ------------------------------------------------------------------ */

/** Détecte le type d'artefact adapté à la sortie d'un outil de création. */
export function inferArtifactType(toolName: string, output: unknown): "code" | "document" | "table" | "image" | "report" | "file" {
  const outputStr = typeof output === "string" ? output : JSON.stringify(output ?? {});
  if (/image|png|jpe?g|webp/i.test(outputStr)) return "image";
  if (toolName.includes("zip")) return "file";
  if (/```|function |const |class |import /.test(outputStr)) return "code";
  if (/\|.*\|/.test(outputStr) && outputStr.split("\n").filter((l) => l.includes("|")).length > 2) return "table";
  return "document";
}

async function artifactFromToolOutput(params: {
  userId: string;
  conversationId: string;
  projectId?: string;
  runId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  output: unknown;
}): Promise<ConversationArtifact | null> {
  const outputRecord = (params.output && typeof params.output === "object" ? params.output : {}) as Record<string, unknown>;
  const content =
    typeof params.output === "string"
      ? params.output
      : typeof outputRecord.content === "string"
        ? outputRecord.content
        : typeof outputRecord.markdown === "string"
          ? outputRecord.markdown
          : undefined;
  const url = typeof outputRecord.url === "string" ? outputRecord.url : undefined;
  const storagePath = typeof outputRecord.path === "string" ? outputRecord.path : typeof outputRecord.key === "string" ? outputRecord.key : undefined;
  if (!content && !url && !storagePath) return null;

  const inputTitle = typeof params.toolInput.title === "string" ? params.toolInput.title : undefined;
  const inputFilename = typeof params.toolInput.filename === "string" ? params.toolInput.filename : typeof params.toolInput.name === "string" ? params.toolInput.name : undefined;
  const type = inferArtifactType(params.toolName, params.output ?? "");
  return createArtifact({
    userId: params.userId,
    conversationId: params.conversationId,
    projectId: params.projectId,
    runId: params.runId,
    type,
    title: (inputTitle || inputFilename || `Artefact — ${params.toolName}`).slice(0, 200),
    language: typeof params.toolInput.language === "string" ? params.toolInput.language : undefined,
    filename: inputFilename,
    content,
    storagePath,
    url,
    note: `Produit par l'outil ${params.toolName}`,
  });
}

/* ------------------------------------------------------------------ */
/* Exécution d'une étape approuvée                                     */
/* ------------------------------------------------------------------ */

export interface ApprovedStepOutcome {
  step: RunStep;
  artifact?: ConversationArtifact;
  summary: string;
}

/** Exécute l'étape d'un run correspondant à une validation approuvée. */
export async function executeApprovedStep(params: {
  userId: string;
  conversationId: string;
  run: ConversationRun;
  approval: ConversationApproval;
}): Promise<ApprovedStepOutcome> {
  const { run, approval } = params;
  const steps = run.steps;
  const stepIndex = steps.findIndex((s) => s.id === approval.stepId);
  if (stepIndex === -1) throw new Error("Étape du run introuvable pour cette validation.");

  const step = steps[stepIndex];
  step.status = "in_progress";
  step.startedAt = new Date().toISOString();
  steps[stepIndex] = step;
  await updateRunSteps(params.userId, run.id, steps);

  const result = await executeTool({
    userId: params.userId,
    executionId: run.id,
    projectId: run.projectId,
    toolName: approval.toolName,
    input: (step.toolInput ?? {}) as Record<string, unknown>,
    policy: CONVERSATION_EXECUTION_POLICY,
  });

  step.finishedAt = new Date().toISOString();
  if (result.success) {
    step.status = "done";
    step.output = condenseToolOutput(result.output);
  } else {
    step.status = "failed";
    step.output = result.error;
  }

  let artifact: ConversationArtifact | undefined;
  if (result.success && TOOL_OUTPUT_ARTIFACTS.has(approval.toolName)) {
    const created = await artifactFromToolOutput({
      userId: params.userId,
      conversationId: params.conversationId,
      projectId: run.projectId,
      runId: run.id,
      toolName: approval.toolName,
      toolInput: (step.toolInput ?? {}) as Record<string, unknown>,
      output: result.output,
    });
    if (created) {
      artifact = created;
      step.artifactId = created.id;
    }
  }

  // Toutes les validations traitées ? On clôture le run.
  const remaining = steps.filter((s) => s.status === "awaiting");
  const hasFailure = steps.some((s) => s.status === "failed");
  if (remaining.length === 0) {
    const status = hasFailure ? "failed" : "completed";
    steps.push(
      makeStep({
        phase: "result",
        title: "Résultat",
        detail: result.success ? "Action validée exécutée avec succès." : "Action validée en échec.",
        status: "done",
      }),
    );
    await finalizeRun(params.userId, run.id, status, steps);
  } else {
    await updateRunSteps(params.userId, run.id, steps);
  }

  const summary = result.success
    ? `Action exécutée : ${approval.title}${step.output ? `\n\n${step.output.slice(0, 600)}` : ""}`
    : `L'action « ${approval.title} » a échoué : ${result.error ?? "erreur inconnue"}`;

  return { step, artifact, summary };
}

/** Marque l'étape d'une validation rejetée comme ignorée et clôture si besoin. */
export async function rejectApprovalStep(params: {
  userId: string;
  run: ConversationRun;
  approval: ConversationApproval;
}): Promise<void> {
  const { run, approval } = params;
  const steps = run.steps;
  const stepIndex = steps.findIndex((s) => s.id === approval.stepId);
  if (stepIndex >= 0) {
    const step = steps[stepIndex];
    step.status = "skipped";
    step.detail = `${step.detail ? `${step.detail}\n` : ""}Rejeté par l'utilisateur le ${new Date().toISOString()}.`;
    steps[stepIndex] = step;
  }
  const remaining = steps.filter((s) => s.status === "awaiting");
  if (remaining.length === 0) {
    steps.push(
      makeStep({
        phase: "result",
        title: "Résultat",
        detail: "Action rejetée par l'utilisateur — aucune donnée n'a été envoyée.",
        status: "done",
      }),
    );
    await finalizeRun(params.userId, run.id, "completed", steps);
  } else {
    await updateRunSteps(params.userId, run.id, steps);
  }
}

/* Réexport pratique pour les API. */
export { runAI as conversationRunAI };

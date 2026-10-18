import { z } from "zod";

import { extractJsonObject, runAI, runAIJSON } from "@/lib/engines/ai-engine";
import { generate, generateStream } from "@/lib/ai/router";
import { stripThinkTags, ThinkTagStreamFilter } from "@/lib/ai/think-filter";
import { RESPONSE_FORMAT_RULES, preferFreeForVisibleAnswers } from "@/lib/ai/response-quality";
import {
  detectImageRatio,
  extractImagePrompt,
  enhanceImagePrompt,
  looksLikeExplicitDrawingRequest,
  looksLikeImageRequest,
} from "@/lib/ai/image-intent";
import { attachmentImageCandidates, resolveEditableImageSources } from "@/lib/files/image-source";
import { hasImageAttachment, shouldRouteImageEdit } from "@/lib/domain/conversations/image-intent";
import { loadWebPageContext } from "@/lib/domain/conversations/web-context";
import { buildKnowledgeContext, shouldSearchKnowledge } from "@/lib/knowledge/chat-context";
import { resolveKnowledgeScope, searchKnowledge } from "@/lib/knowledge/search";
import { isR2Configured, uploadToR2 } from "@/lib/storage/r2";
import { randomUUID } from "node:crypto";
import type { ToolRisk } from "@/lib/tools/types";
import { createDefaultToolRegistry } from "@/lib/tools/default-registry";
import { executeTool } from "@/lib/tools/executor";
import type { ExecutionPolicy } from "@/lib/security/execution-policy";
import {
  AUTO_APPROVAL_AUDIT_REASON,
  isAutoApprovable,
  type AuthorizationMode,
} from "@/lib/security/authorization-mode";
import { detectApiProvisioning, extractApiPathFromMessage, extractApiUsageName, looksLikeApiUsageRequest } from "@/lib/integrations/custom-apis/detect";
import { isExternalAppConnected } from "@/lib/security/connected-apps";
import { parseConnectorMissing, uniqueToolkits } from "@/lib/integrations/composio/errors";
import { describeServersForPrompt } from "@/lib/integrations/mcp/service";
import { INTERNAL_ACTION_TOOLS } from "@/lib/agents/approval-policy";
import { getAgentForUser } from "@/lib/agents/repository";
import { buildAgentCharter } from "@/lib/agents/charter";
import { buildFollowUpSuggestions } from "./follow-ups";
import {
  assessComplexity,
  buildEvolutionContext,
  buildRunHistoryContext,
  recordRunOutcome,
  type ComplexityAssessment,
} from "@/lib/ai/auto-improvement";
import { enhancePromptForExecution, languageDirective } from "@/lib/ai/prompt-enhancer";
import { imagesForModel } from "@/lib/ai/vision-input";
import { extractVideoParams, extractVideoTitle, looksLikeVideoRequest } from "@/lib/ai/video-intent";
// Task 135 — clarification d'intention : marqueur 🔄, suivi contextuel et
// garde déterministe d'ambiguïté (amélioration #1).
import { markClarification, resolveClarifiedObjective, detectAmbiguitySignals, deterministicClarifyingQuestion } from "@/lib/ai/clarification-followup";
import { sanitizeProductionOptions, VIDEO_ASPECT_RATIOS } from "@/lib/tools/media/create-video";
import { createCustomApi, listEnabledCustomApis, type CustomApiRecord } from "@/lib/integrations/custom-apis/repository";
import { isEmailProviderConfigured } from "@/lib/integrations/email/send";
import { getImportedFileContent, listImportedFiles, loadImportedFilesContext } from "@/lib/files/import";
import {
  detectScheduleIntent,
  detectServiceControlIntent,
  detectWorkflowIntent,
  isDraftEmailRequest,
  type ScheduleIntent,
  type ServiceControlIntent,
  type WorkflowIntent,
} from "./service-intents";
import {
  APP_SYSTEM_PROMPT,
  appendPreviewLinks,
  buildAppUserRequest,
  buildChartHtml,
  chartDataFromTable,
  detectAppCreationIntent,
  detectChartIntent,
  extractHtmlDocument,
  extractInlineData,
  type AppCreationIntent,
  type ChartIntent,
} from "./artefact-apps";

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
  RunStatus,
  RunStep,
} from "./types";
import { buildContextWindow, estimateTokens } from "./context-window";
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
    // email.send n'est proposé QUE si le fournisseur d'emails est configuré
    // (vérifié dynamiquement : l'environnement peut changer entre le chargement
    // du module et l'exécution d'un tour).
    .filter((tool) => (tool.id ?? tool.name) !== "email.send" || isEmailProviderConfigured())
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
  if (toolName.startsWith("composio.") || toolName.startsWith("mcp.")) return "inclus (application connectée)";
  if (toolName.startsWith("custom_api.")) return "gratuit (votre API — quota du fournisseur)";
  if (toolName === "workflow.run" || (toolName === "workflow.create")) return "gratuit à la création ; exécution facturée selon les modèles";
  if (toolName.startsWith("schedule.") || toolName.startsWith("workflow.")) return "gratuit";
  if (toolName === "image.generate") return "gratuit (moteur neuronal local)";
  if (toolName === "video.create") return "production locale (visuels neuraux, rendu interne)";
  if (toolName === "video.revise") return "gratuit";
  // Task 140 — suite « outils pilotés par les agents IA ».
  if (toolName === "build.autofix") return "appels LLM facturés à l'usage (analyse du log + correctif)";
  if (toolName === "voicemail.respond") return "appels LLM facturés à l'usage + envoi email/SMS selon canal";
  if (toolName === "webhook.heal") return "appels LLM facturés à l'usage (adaptation du payload)";
  if (toolName === "handover.compose" || toolName === "terminal.guide" || toolName === "content.package" || toolName === "knowledge.graph" || toolName === "simulation.run" || toolName === "schema.extract" || toolName === "ivr.navigate" || toolName === "watchdog.track") return "appels LLM facturés à l'usage";
  return "gratuit";
}

/** Périmètre de données lisible affiché sur la carte de validation. */
export function dataScopeForTool(toolName: string, input: unknown): string {
  const target =
    input && typeof input === "object" && "toolkit" in (input as Record<string, unknown>)
      ? String((input as Record<string, unknown>).toolkit)
      : undefined;
  const apiName =
    input && typeof input === "object" && "apiName" in (input as Record<string, unknown>)
      ? String((input as Record<string, unknown>).apiName)
      : undefined;
  if (toolName === "custom_api.call") return `Appel en lecture vers votre API${apiName ? ` « ${apiName} »` : " personnelle"}`;
  if (toolName === "custom_api.write") return `Modification de données dans votre API${apiName ? ` « ${apiName} »` : " personnelle"}`;
  if (toolName === "web.api") {
    const url = input && typeof input === "object" && "url" in (input as Record<string, unknown>) ? String((input as Record<string, unknown>).url) : undefined;
    return `Appel en lecture vers l'API${url ? ` ${url}` : " désignée par URL"}`;
  }
  if (toolName === "web.api.write") {
    const url = input && typeof input === "object" && "url" in (input as Record<string, unknown>) ? String((input as Record<string, unknown>).url) : undefined;
    return `Modification de données via l'API${url ? ` ${url}` : " désignée par URL"}`;
  }
  if (toolName === "schedule.create" || toolName === "schedule.update") return "Vos tâches planifiées (automatisations d'agents)";
  if (toolName === "schedule.delete") return "Suppression définitive d'une automatisation récurrente";
  if (toolName === "workflow.create") return "Vos workflows (automatisations multi-étapes)";
  if (toolName === "workflow.run") return "Exécution complète du workflow (modèles facturés)";
  if (toolName === "workflow.delete") return "Suppression définitive d'un workflow";
  if (toolName === "composio.execute") return `Application connectée${target ? ` « ${target} »` : ""} — action externe`;
  if (toolName === "mcp.call") return "Serveurs MCP connectés (Drive, GitHub, bases de données…)";
  if (toolName === "email.send") return "Destinataire du message + signature plateforme";
  if (toolName === "messaging.send") return "Canal de messagerie connecté (WhatsApp, Telegram, Slack)";
  if (toolName === "social.publish") return "Compte social connecté — publication publique";
  if (toolName === "webhook.emit") return "Endpoints webhook déclarés par votre compte";
  if (toolName === "github.create_repository") return "Votre compte GitHub — nouveau dépôt";
  if (toolName === "file.create" || toolName === "artifact.create") return "Votre stockage permanent Gen3ia";
  if (toolName === "memory.write") return "Mémoire permanente de vos agents";
  if (toolName === "image.generate") return "Génération d'une image à partir de votre description (stockée dans votre espace)";
  if (toolName === "video.create") return "Production vidéo complète : scénario, visuels, voix, montage et rendu (votre espace vidéo)";
  if (toolName === "video.status") return "Suivi de votre production vidéo (étape, progression, URL du master)";
  if (toolName === "video.revise") return "Révision/pilotage de votre vidéo (musique, rythme, voix, pause, exports)";
  if (toolName.startsWith("cloudflare.")) return "Zones DNS Cloudflare autorisées";
  if (toolName.startsWith("notion.")) return "Espace Notion autorisé";
  // Task 140 — suite « outils pilotés par les agents IA ».
  if (toolName === "build.autofix") return "Log de build fourni + contenu du dépôt GitHub ciblé (lecture, puis pull request corrective)";
  if (toolName === "voicemail.respond") {
    const target = input && typeof input === "object" && "destinationEmail" in (input as Record<string, unknown>) ? String((input as Record<string, unknown>).destinationEmail) : undefined;
    return `Transcription du message vocal + destinataire${target ? ` (${target})` : " de la réponse"}`;
  }
  if (toolName === "webhook.heal") {
    const url = input && typeof input === "object" && "endpointUrl" in (input as Record<string, unknown>) ? String((input as Record<string, unknown>).endpointUrl) : undefined;
    return `Re-soumission du payload vers votre endpoint${url ? ` ${url}` : ""}`;
  }
  if (toolName === "handover.compose") return "Transcription de la conversation (brief de relais stocké dans votre espace)";
  if (toolName === "terminal.shield") return "Commande exécutée dans le terminal agent isolé (workspace /tmp éphémère)";
  if (toolName === "simulation.run") {
    const url = input && typeof input === "object" && "targetUrl" in (input as Record<string, unknown>) ? String((input as Record<string, unknown>).targetUrl) : undefined;
    return `Simulation multi-personas de la cible décrite${url ? ` (${url} lu en direct)` : ""} — rapport stocké dans votre espace`;
  }
  if (toolName === "watchdog.track") {
    const url = input && typeof input === "object" && "url" in (input as Record<string, unknown>) ? String((input as Record<string, unknown>).url) : undefined;
    return `Page surveillée${url ? ` (${url})` : ""} — référence et historique stockés dans votre compte`;
  }
  if (toolName === "transcript.redact") return "Transcription transformée en mémoire (aucune donnée stockée)";
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
  /** Canal de clarification (Task 135 — compréhension EXACTE) : vrai si
   *  la compréhension n'est pas certaine (ambiguïté réelle, référent
   *  implicite non résolvable, action coûteuse sur une interprétation
   *  hasardeuse) — alors poser UNE question précise pour se rassurer. */
  needsClarification: z.boolean().optional(),
  clarifyingQuestion: z.string().max(600).optional().describe("Une seule question de clarification, si needsClarification"),
  /** Confiance dans la compréhension de la demande (0.0..1.0). */
  confidence: z.number().min(0).max(1).optional(),
  /** Options de réponse rapides proposées à l'utilisateur (max 3). */
  suggestions: z.array(z.string().max(60)).max(3).optional(),
});

export type TurnIntent = z.infer<typeof IntentSchema>;

export type ExplicitToolIntent =
  | { toolName: "web.search"; query: string }
  | { toolName: "custom_api.call"; query: string }
  | { toolName: "web.api"; url: string }
  | { toolName: "web.api.write"; url: string; method: "POST" | "PUT" | "PATCH" | "DELETE"; body?: string }
  | { toolName: "artifact.create"; document: { title: string; format: "pdf" | "docx" | "xlsx" | "pptx" | "md" } }
  | { toolName: "email.send"; to: string; subject: string; text: string };

const EMAIL_ADDRESS_RE = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/;

/**
 * Extrait le sujet énoncé (« avec le sujet « … » », « sujet : … ») ou un repli honnête.
 */
export function extractEmailSubject(message: string): string {
  const quoted = message.match(/(?:sujet|subject|objet)\s*[:：]?\s*[«“"']([^»”"']{1,160})[»”"']/i);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  const plain = message.match(/(?:sujet|subject|objet)\s*[:：]\s*([^«»“”"'\n]{3,160})/i);
  if (plain?.[1]?.trim()) return plain[1].trim();
  return "[Gen3ia] Message de votre agent";
}

/**
 * Extrait le corps énoncé (« et le texte « … » », « message : … ») ou repli sur la demande elle-même.
 */
export function extractEmailText(message: string): string {
  const quoted = message.match(/(?:texte|message|contenu|corps|dis que|dis-lui que)\s*[:：]?\s*[«“"]([^»”"]{1,2000})[»”"]?/i);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  return message.replace(EMAIL_ADDRESS_RE, "").replace(/\s{2,}/g, " ").trim().slice(0, 1000) || message.slice(0, 1000);
}

/**
 * Garde-fou déterministe : certaines demandes énoncent EXPLICITEMENT le
 * résultat attendu (recherche web réelle, document téléchargeable). Si l'IA
 * classe malgré tout la demande en simple réponse (ou si sa décision est
 * indisponible), cette heuristique force un plan avec l'outil réel — la
 * demande de l'utilisateur est loi.
 *
 * Audits 25-a/25-d : « Recherche les dernières tendances… » produisait une
 * réponse SANS sources (hallucination possible) et « Crée un PDF… » ne
 * générait jamais de livrable — ces deux familles sont désormais routées.
 */
export function detectExplicitToolIntent(message: string, catalog: ToolCatalogEntry[], customApis: CustomApiRecord[] = []): ExplicitToolIntent | null {
  const lower = message.toLowerCase();
  const catalogNames = new Set(catalog.map((t) => t.name));

  // 1) Recherche web explicite (« fais une recherche web », « search the web »).
  const webMarkers = /(recherche[s]? (web|internet)|cherche[rz]? (sur )?(le |la )?(web|internet)|fais[ez]? une recherche|search (the )?web|web search|sur (le|internet))\b/i;
  if (webMarkers.test(lower) && catalogNames.has("web.search")) {
    return { toolName: "web.search", query: extractSearchQuery(message) };
  }

  // 1 bis) Demande explicite d'UTILISATION d'une API personnelle connue :
  // l'appel réel est la demande de l'utilisateur, jamais un simple « chat ».
  if (
    customApis.length > 0 &&
    catalogNames.has("custom_api.call") &&
    looksLikeApiUsageRequest(message)
  ) {
    const wanted = extractApiUsageName(message);
    const api = wanted
      ? customApis.find((candidate) => candidate.name.toLowerCase().includes(wanted.toLowerCase()) || wanted.toLowerCase().includes(candidate.name.toLowerCase()))
      : customApis.length === 1
        ? customApis[0]
        : undefined;
    if (api) return { toolName: "custom_api.call", query: message.slice(0, 400) };
  }

  // 1 ter) Appel d'API DIRECT par URL : l'utilisateur désigne l'URL d'une API
  // (avec un verbe d'appel, le mot « API » ou une hôte api.*) — l'agent
  // appelle RÉELLEMENT cette API, sans connecteur préalable.
  const directUrl = extractApiUrlFromMessage(message);
  if (directUrl && catalogNames.has("web.api") && looksLikeDirectApiCall(message, directUrl)) {
    // Garde déterministe ÉCRITURE : un verbe/méthode d'écriture (POST, PUT,
    // PATCH, DELETE, création, modification) route vers web.api.write —
    // JAMAIS web.api (lecture seule) pour une écriture.
    const writeIntent = detectApiWriteIntent(message);
    if (writeIntent && catalogNames.has("web.api.write")) {
      return { toolName: "web.api.write", url: directUrl, method: writeIntent.method, ...(writeIntent.body ? { body: writeIntent.body } : {}) };
    }
    return { toolName: "web.api", url: directUrl };
  }

  // 2 bis) Envoi d'email EXPLICITE : verbe d'envoi + mot email + adresse
  // destinataire réellement énoncée. L'envoi réel (Resend) est la demande de
  // l'utilisateur — jamais une réponse « je ne peux pas envoyer d'emails ».
  // Attention : rédiger/brouiller un email (sans envoi ni adresse) ne déclenche PAS le garde.
  const emailSendVerb = /\b(envoi[ez]|envoie|envoyer|exp[ée]di\w*|transmets?|transmets|send)\b/i;
  const emailWord = /\b(e-?mails?|courriels?)\b/i;
  // Garde « brouillon » : rédiger/préparer un email n'est PAS un envoi réel —
  // la demande reste conversationnelle (audit compréhension : « envoie-moi un
  // brouillon d'email… » ne doit jamais partir chez Resend).
  if (catalogNames.has("email.send") && emailSendVerb.test(lower) && emailWord.test(lower) && !isDraftEmailRequest(message)) {
    const address = message.match(EMAIL_ADDRESS_RE)?.[0];
    if (address) {
      return {
        toolName: "email.send",
        to: address,
        subject: extractEmailSubject(message),
        text: extractEmailText(message),
      };
    }
  }

  // 2) Recherche d'information ACTUELLE : verbe d'action + sujet qui exige des
  //    données à jour (tendances, actualités, prix, marché…) — une réponse de
  //    mémoire serait une fabrication sans sources.
  const researchVerb = /\b(recherch\w*|cherch\w*|trouv\w*|renseign\w*|surveill\w*|compar\w*|informe[rz]?)\b/i;
  const currentInfoSubject = /\b(tendances?|actualit[ée]s?|nouveaut[ée]s?|news|derni[èe]res? (informations|nouvelles|tendances|versions?|donn[ée]es)|march[ée]|concurrents?|concurrence|prix|tarifs?|m[ée]t[ée]o|r[ée]glementation)\b/i;
  if (researchVerb.test(lower) && currentInfoSubject.test(lower) && catalogNames.has("web.search")) {
    return { toolName: "web.search", query: extractSearchQuery(message) };
  }

  // 3) Livrable document explicite (« prépare un rapport », « crée un PDF ») :
  //    force un plan avec artifact.create — le moteur complète les blocs de
  //    contenu à l'exécution (voir ensureArtifactInput).
  const documentVerb = /\b(fais|pr[ée]par\w*|cr[ée]\w*|g[ée]n[èe]r\w*|r[ée]dig\w*|construis|produis|transforme|exporte)\b/i;
  const documentObject = /\b(rapport|comptes? rendus?|note de synth[èe]se|pr[ée]sentation|diaporama|slides?|documents?|pdf|docx|word|excel|xlsx|powerpoint|pptx|tableau de bord)\b/i;
  if (documentVerb.test(lower) && documentObject.test(lower) && catalogNames.has("artifact.create")) {
    return {
      toolName: "artifact.create",
      document: { title: extractDocumentTitle(message), format: extractDocumentFormat(message) },
    };
  }

  const imageMarkers = /\b(g[eé]n[eè]re|cr[eé]e|dessine)\b.*\b(image|illustration|dessin|visuel)\b|\b(image|illustration)\b.*\b(g[eé]n[eè]r)\b/i;
  if (imageMarkers.test(lower) && catalogNames.has("artifact.create")) {
    // Les images sont traitées en amont par Agnes ; ici on ne force rien.
    return null;
  }
  return null;
}

/** Titre court d'un livrable dérivé de la demande (nettoyage des formules). */
export function extractDocumentTitle(message: string): string {
  const cleaned = message
    .replace(/^(fais[ez]?|peux[- ]tu|pourrais[- ]tu|merci de|stp|s'il (te|vous) pla[eî]t)\s+/i, "")
    .replace(/^(sur |about )+/i, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
  return (cleaned || message.trim()).slice(0, 80);
}

/** Format de document demandé — déduction prudente, PDF par défaut. */
export function extractDocumentFormat(message: string): "pdf" | "docx" | "xlsx" | "pptx" | "md" {
  const lower = message.toLowerCase();
  if (/\b(pr[ée]sentation|diaporama|slides?|powerpoint|pptx)\b/i.test(lower)) return "pptx";
  if (/\b(excel|xlsx|tableau de bord|feuille de calcul)\b/i.test(lower)) return "xlsx";
  if (/\b(word|docx)\b/i.test(lower)) return "docx";
  if (/\b(markdown|\.md)\b/i.test(lower)) return "md";
  return "pdf";
}

/**
 * Extrait la première URL http(s) énoncée (ponctuation finale exclue).
 * Utilisée par le garde d'appel d'API directe par URL (web.api).
 */
export function extractApiUrlFromMessage(message: string): string | null {
  const match = message.match(/https?:\/\/[^\s<>"'»“”')\]]+/i);
  if (!match) return null;
  return match[0].replace(/[.,;:!?]+$/, "");
}

/**
 * L'appel d'API direct est-il explicitement demandé ? L'utilisateur désigne
 * une URL d'API avec un verbe d'appel, le mot « API », ou une hôte de type
 * api.*. Un simple lien collé sans intention d'appel ne déclenche PAS l'outil.
 */
export function looksLikeDirectApiCall(message: string, url: string): boolean {
  const callVerb = /\b(appell\w*|interrog\w*|consult\w*|requ[eê]t\w*|call|request|fetch|r[ée]cup[ée]r\w*|utilise|tester?|essaie)\b/i;
  const apiWord = /\bapi\b/i;
  const apiHost = /(^|\/\/|\.)api\./i.test(url);
  return apiWord.test(message) || apiHost || callVerb.test(message);
}

/**
 * Détecte une ÉCRITURE API énoncée : méthode explicite (POST/PUT/PATCH/
 * DELETE) ou verbe de modification. Retourne la méthode et, si présente,
 * le corps JSON énoncé (extrait tel quel — jamais inventé).
 */
export function detectApiWriteIntent(message: string): { method: "POST" | "PUT" | "PATCH" | "DELETE"; body?: string } | null {
  const methodMatch = message.match(/\b(POST|PUT|PATCH|DELETE)\b/i);
  const writeVerb = /\b(cr[ée]er?|cr[ée]ez|cr[ée]e\s|ajout\w*|envoi\w*|publi\w*|modifi\w*|supprim\w*|mets?\s+à\s+jour|met[s]?\s+à\s+jour|mise\s+à\s+jour|create|send|update|delete)\b/i;
  const jsonMatch = message.match(/(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/);
  if (!methodMatch) {
    // Verbe d'écriture + corps JSON explicite + URL : écriture probable (POST par défaut).
    if (writeVerb.test(message) && jsonMatch) return { method: "POST", body: jsonMatch[1] };
    return null;
  }
  const method = methodMatch[1].toUpperCase() as "POST" | "PUT" | "PATCH" | "DELETE";
  return { method, ...(jsonMatch ? { body: jsonMatch[1] } : {}) };
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

export interface IntentPromptMeta {
  /** Contexte d'auto-amélioration (leçons + progression réelle). */
  evolutionContext?: string;
  /** Historique réel des runs de la conversation. */
  runHistoryContext?: string;
  /** Évaluation de complexité de la demande. */
  complexity?: ComplexityAssessment;
  /** Directive de langue calculée depuis le dernier message utilisateur. */
  languageDirective?: string;
}

export function buildIntentSystemPrompt(
  catalog: ToolCatalogEntry[],
  project?: WorkspaceProject | null,
  connectors?: string[],
  customApis?: CustomApiRecord[],
  meta?: IntentPromptMeta,
  /** Task 143 — axe 4 : note des serveurs MCP actifs (outils + arguments). */
  mcpNote?: string,
): string {
  const toolLines = catalog
    .map((t) => `- ${t.name} (risque ${t.risk}${t.requiresApproval ? ", validation requise" : ""}) : ${t.description}`)
    .join("\n");
  const catalogNames = new Set(catalog.map((t) => t.name));
  const connectorSection = connectors && connectors.length > 0
    ? [
        "",
        `Connecteurs activés explicitement par l'utilisateur pour CETTE demande : ${connectors.join(", ")}.`,
        "Si la demande concerne ces services, utilise l'outil composio.execute avec input { toolkit: \"<slug>\", action: \"<action>\", params: { … } }.",
        "Les actions externes (envoi, publication, modification) sont sensibles : décris leur impact précisément, la validation humaine sera demandée.",
      ].join("\n")
    : "";
  const customApiSection = customApis && customApis.length > 0
    ? [
        "",
        "API personnelles de l'utilisateur (RÉELLES, appelées par le serveur via custom_api.call / custom_api.write) :",
        ...customApis.map((api) => {
          const selected = connectors?.some((slug) => slug === `api-${api.id}`);
          return `- « ${api.name} » — base : ${api.baseUrl}${api.description ? ` — ${api.description.slice(0, 200)}` : ""}${selected ? " [ACTIVÉE pour ce message]" : ""} ; auth : ${api.authType}`;
        }),
        "Pour interroger une de ces API : étape avec toolName=\"custom_api.call\" et toolInput { apiName: \"<nom exact>\", path: \"/chemin\", query?: {…} } — l'appel HTTP réel est exécuté par le serveur et le résultat réel te sera renvoyé.",
        "Pour modifier des données via ces API : toolName=\"custom_api.write\" (POST/PUT/PATCH/DELETE, validation humaine requise).",
        "Utilise ces API uniquement si la demande s'y prête ; ne devine jamais un chemin : si le chemin est inconnu, commence par un appel GET sur la racine ou un chemin probable, et restitue le résultat réel.",
      ].join("\n")
    : "";
  const sousServicesSection = [
    "",
    "SOUS-SERVICES DU PROJET (tous pilotables en langage naturel par l'utilisateur) :",
    "- Tâches planifiées : schedule.create (récurrence hebdomadaire/webhook/veille), schedule.list, schedule.update (activer/désactiver/modifier), schedule.delete (validation requise).",
    "- Workflows : workflow.create (graphe multi-étapes réel), workflow.list, workflow.run (exécution réelle), workflow.delete (validation requise).",
    "Si l'utilisateur demande de planifier/automatiser une tâche récurrente : mode=plan avec UN step toolName=\"schedule.create\" et toolInput { objective: \"<exactement ce que l'agent fera>\", daysOfWeek: [1] (0=dimanche…6=samedi déduits de la demande), startTime: \"09:00\", endTime: \"23:59\", name? } — reprends UNIQUEMENT ce qui est énoncé.",
    "Si l'utilisateur décrit un enchaînement d'automatisation : mode=plan avec UN step toolName=\"workflow.create\" et toolInput { name, steps: [{ name, description }] (les étapes EXACTES énoncées), runNow?: true seulement s'il demande l'exécution immédiate }.",
    "Si l'utilisateur veut consulter/piloter ses tâches planifiées ou workflows existants : schedule.list / schedule.update (enable: true|false) / workflow.list / workflow.run.",
  ].join("\n");
  const artefactsSection = [
    "",
    "ARTEFACTS GEN3IA (natifs, gérés par le moteur avant toi) :",
    "- APPLICATIONS WEB : toute demande de création d'une page web, d'un site, d'une interface ou d'une petite application (« crée une page web de liste de tâches en mode sombre, écrite en React ») est générée AUTOMATIQUEMENT par le moteur : artefact exécutable + lien d'aperçu en direct dans la réponse. Si la demande lui a déjà été transmise, réponds mode=chat avec un reply court.",
    "- ANALYSE DE DONNÉES : « génère un graphique / analyse ces données » est pris en charge automatiquement (graphique réel à partir des fichiers importés ou des valeurs énoncées, export PNG/JPG, conclusions). Demande un fichier ou des valeurs si l'utilisateur n'en fournit pas — n'invente JAMAIS de données.",
    "- RÉDACTION / DOCUMENTS : rapports et textes longs → artifact.create avec format pdf ou docx (export direct prêt à diffuser).",
    "- AI SLIDES : « crée une présentation / un PowerPoint » → artifact.create avec format pptx (modèles professionnels appliqués automatiquement).",
  ].join("\n");
  const emailSection = catalogNames.has("email.send")
    ? [
        "",
        "EMAIL — l'envoi d'emails réels est DISPONIBLE via l'outil email.send (service Resend configuré côté serveur) :",
        "Si l'utilisateur demande d'envoyer/expédier un email (relance, notification, rapport, message à une adresse) : mode=plan avec UN step toolName=\"email.send\" et toolInput { to: \"<adresse exacte énoncée>\", subject: \"<sujet énoncé ou fidèle à la demande>\", text: \"<contenu énoncé ou reformulé fidèlement>\" }.",
        "Ne réponds JAMAIS que tu ne peux pas envoyer d'emails : tu le peux, l'envoi est exécuté par le serveur. N'invente jamais une adresse : utilise uniquement celle que l'utilisateur a énoncée.",
      ].join("\n")
    : "";
  const directApiSection = catalogNames.has("web.api")
    ? [
        "",
        "API DIRECTES PAR URL (sans connecteur préalable) :",
        "Si l'utilisateur désigne l'URL d'une API (ou colle une URL d'API) et demande de l'appeler, l'interroger ou l'utiliser : étape toolName=\"web.api\" avec toolInput { url: \"<URL exacte énoncée>\" } — l'appel HTTP réel est exécuté par le serveur et le résultat réel te sera renvoyé.",
        "Pour modifier des données via une URL d'API (POST/PUT/PATCH/DELETE, création, envoi, mise à jour) : toolName=\"web.api.write\" avec toolInput { url, method, body? } — JAMAIS web.api pour une écriture (web.api est en lecture seule GET). Validation humaine requise UNIQUEMENT si l'app cible n'est pas déjà connectée ; app connectée = exécution directe.",
        "N'invente JAMAIS une URL ni une clé : utilise uniquement ce que l'utilisateur a énoncé.",
      ].join("\n")
    : "";
  const mediaSection = [
    "",
    "RÈGLE IMPÉRATIVE — VISUELS : toute demande de CRÉATION d'image, photo, illustration, dessin, logo, affiche, poster, bannière, avatar, icône, fond d'écran ou miniature est routée en mode=plan avec UN SEUL step :",
    '  { title: "Génération de l\'image", toolName: "image.generate", toolInput: { prompt: "<description visuelle fidèle de CE QUE L\'UTILISATEUR a demandé — le sujet exact, sans rien ajouter ni inventer>" } }.',
    "Cela vaut quel que soit la formulation (« dessine-moi un chat », « je veux une photo de… », « un logo pour ma boulangerie », « fais-moi une image de… »). Ne réponds JAMAIS une demande de visuel par du texte seul.",
    catalogNames.has("video.create")
      ? [
          "",
          "RÈGLE IMPÉRATIVE — VIDÉO : toute demande de CRÉATION/PRODUCTION d'une vidéo, clip, reel, short, trailer, bande-annonce ou montage vidéo est routée en mode=plan avec UN SEUL step :",
          '  { title: "Production vidéo", toolName: "video.create", toolInput: { prompt: "<la demande EXACTE de l\'utilisateur : sujet, ton, message — fidèle, sans rien inventer>", title?: "<titre court>", aspectRatio?: "16:9" | "9:16" | "1:1" | "4:5" | "21:9", targetDurationSec?: <durée en secondes si l\'utilisateur la précise>, resolution?: "480p" | "720p" | "1080p" | "1440p" | "4K", language?: "<langue>", style?: "<style visuel/narratif>", audience?: "<public cible>", platform?: "<plateforme>", musicMood?: "cinematographique" | "documentaire" | "tension" | "energique" | "emotionnel" | "neutre", subtitlesEnabled?: boolean (sous-titres demandés/refusés), subtitleStyle?: "documentary" | "minimal" | "shorts_bold" | "cinematic_yellow" | "karaoke_pop", subtitlePosition?: "bottom" | "center" | "top", effectPreset?: "none" | "subtle" | "dynamic" | "cinematic" | "capcut", derivedTargets?: ["shorts_9_16" | "tiktok_9_16" | "reels_9_16" | "youtube_16_9" | "square_1_1" | "facebook_16_9"] } }.',
          "TRANSMETS FIDÈLEMENT les paramètres exprimés par l'utilisateur (durée « 2 minutes » → targetDurationSec: 120, « format TikTok » → aspectRatio 9:16 + derivedTargets [tiktok_9_16], « en 4K », « musique énergique », « pour les adolescents »…) — n'invente JAMAIS un paramètre absent de la demande. Les bornes du pipeline (durée minimale 10 s) sont appliquées automatiquement : transmets la durée demandée telle quelle.",
          "EFFETS D'ANIMATION ET SOUS-TITRES (règle impérative) : si l'utilisateur demande des effets d'animation ou des sous-titres, transmets-les TOUJOURS — « avec sous-titres karaoké » → subtitlesEnabled: true + subtitleStyle 'karaoke_pop' ; « sous-titres jaunes » → 'cinematic_yellow' ; « sans sous-titres » → subtitlesEnabled: false ; « effets dynamiques » → effectPreset 'dynamic' ; « style cinématique » → 'cinematic' ; « comme CapCut » → 'capcut' ; « sans effets » → 'none'. La détection déterministe du serveur rattrape les oublis, mais transmets fidèlement dès le plan.",
          "La production complète (scénario, visuels, voix, musique, montage, rendu) est enchaînée AUTOMATIQUEMENT par la plateforme, avec progression en temps réel affichée dans la conversation. Ne réponds JAMAIS une demande de vidéo par du texte seul, et ne demande JAMAIS de passer par l'atelier vidéo : tu lances la production toi-même.",
        ].join("\n")
      : "",
    catalogNames.has("voice.speak")
      ? [
          "",
          "RÈGLE IMPÉRATIVE — AUDIO / VOIX-OFF (la plateforme SYNTHÉTISE l'audio — ne réponds JAMAIS que la plateforme ne fait pas d'audio) : toute demande de GÉNÉRATION d'un audio, d'une voix-off, d'une narration parlée, d'un texte lu ou d'une synthèse vocale est servie par la plateforme : mode=plan avec UN SEUL step :",
          '  { title: "Synthèse vocale", toolName: "voice.speak", toolInput: { text: "<le texte EXACT à faire entendre, fidèle à la demande>", voiceId?: "<si l\'utilisateur en précise un>" } }.',
          "Si le texte à faire entendre n'est pas encore connu (ex : « génère-moi un audio de 5s » sans contenu), réponds mode=chat avec UNE SEULE question demandant le texte à synthétiser — ne refuse JAMAIS, ne propose JAMAIS un service externe ni un tutoriel.",
          "Si l'utilisateur répond ensuite avec le texte attendu, ce message EST le texte à synthétiser : route-le en voice.speak avec CE texte exact.",
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const clarificationSection = [
    "",
    "CLARIFICATION (compréhension exacte — MIEUX VAUT DEMANDER QUE MAL EXÉCUTER) :",
    "Avant de choisir le mode, reformule silencieusement la demande dans `understanding` — fidèle aux mots de l'utilisateur.",
    "Pose UNE seule question (needsClarification=true + clarifyingQuestion, une question courte, précise, en français) QUAND LA COMPRÉHENSION N'EST PAS CERTAINE :",
    "  - la demande est ambiguë entre deux actions matériellement différentes (ex. « fais une vidéo sur X » sans durée ni format ET deux interprétations majeures) ;",
    "  - un référent est implicite et non résolvable par l'historique (« fais-le », « la même chose », « continue ») ;",
    "  - une action coûteuse ou irréversible serait exécutée sur une interprétation hasardeuse (confidence < 0.55).",
    "Renseigne `confidence` (0.0..1.0 — ta confiance dans ta compréhension EXACTE de la demande) et, si tu poses une question, `suggestions` (1-3 réponses courtes cliquables que l'utilisateur pourrait choisir).",
    "IMPORTANT : si l'utilisateur RÉPOND à une question de clarification précédente (marquée 🔄 Précision dans l'historique), sa réponse EST l'information manquante — exécute la demande complète (origine + précision), ne re-demande JAMAIS la même information.",
    "Dans tous les autres cas, agis : choisis l'interprétation la plus probable et exécute. Une question inutile reste une erreur — mais une mission mal comprise en est une plus grave.",
  ].join("\n");
  const base = [
    "Tu es le moteur d'exécution de Gen3ia, une plateforme d'agents avec connecteurs.",
    "AGENT UNIVERSEL (impératif) : tu peux TOUT réaliser sans exception — images, vidéos, audios/voix-off, documents, analyses de médias, applications, automatisations, connecteurs. Ne dis JAMAIS qu'une demande est « hors de ton cadre », « impossible » ou « non prise en charge » tant qu'elle est légale. Si un outil nécessaire manque au catalogue, explique ce qui doit être activé ou connecté et demande à l'utilisateur les accès/outils nécessaires (ex : « connectez l'application X ») — tu proposes toujours un CHEMIN pour réaliser la tâche, jamais un refus sec.",
    "Pour chaque demande utilisateur, tu décides :",
    '  mode="chat" : la demande se traite par une simple réponse textuelle (question, explication, rédaction courte). Remplis alors `reply`.',
    '  mode="plan" : la demande exige des actions réelles (recherche, fichiers, applications connectées, publication…). Remplis alors `objective` et 1 à 8 `steps`.',
    "Chaque step avec un toolName doit utiliser EXACTEMENT un des outils du catalogue ci-dessous, avec toolInput conforme à sa description.",
    "Un step sans toolName est une étape de raisonnement/rédaction exécutée par toi-même.",
    "Les outils marqués « validation requise » ne seront exécutés qu'après approbation explicite de l'utilisateur : décris leur impact précisément dans detail.",
    "Ne propose jamais un outil qui n'est pas dans le catalogue. Ne fabrique pas d'identifiants, de tokens ou de numéros.",
    mediaSection,
    clarificationSection,
    "",
    "Catalogue d'outils disponibles :",
    toolLines,
    "- image.generate (risque low) : génère une image réelle et photoréaliste à partir d'une description visuelle (input { prompt }).",
    catalogNames.has("video.create")
      ? "- video.create (risque medium) : lance une production vidéo complète autonome — scénario, visuels de scènes, voix, musique, montage, rendu — avec progression en temps réel (input { prompt, title?, aspectRatio?: 16:9|9:16|1:1|4:5|21:9, targetDurationSec?, resolution?, language?, style?, audience?, platform?, musicMood?, subtitlesEnabled?, subtitleStyle?: documentary|minimal|shorts_bold|cinematic_yellow|karaoke_pop, subtitlePosition?: bottom|center|top, effectPreset?: none|subtle|dynamic|cinematic|capcut, derivedTargets? })."
      : "",
    catalogNames.has("video.status")
      ? "- video.status (gratuit) : suit une production vidéo en cours — étape, progression réelle, avertissements, URL de lecture du master une fois terminé (input { jobId? | projectId? } — dernier lancement par défaut)."
      : "",
    catalogNames.has("video.revise")
      ? "- video.revise : réviser/piloter une vidéo EXISTANTE en langage naturel — rythme, musique, voix (\"utilise ma voix\"), style de sous-titres, suppression/régénération de scène, pause/reprise/annulation du rendu, formats dérivés (input { projectId, action?: revise|pause_render|resume_render|cancel_render|add_exports, instruction?, targets? })."
      : "",
    "",
    project?.instructions ? `Instructions persistantes du projet « ${project.name} » (à respecter) :\n${project.instructions}` : "",
    project?.privacyRules ? `Règles de confidentialité du projet (impératives) :\n${project.privacyRules}` : "",
    connectorSection,
    customApiSection,
    directApiSection,
    sousServicesSection,
    artefactsSection,
    emailSection,
    // Task 143 — axe 4 : les serveurs MCP de l'utilisateur sont des outils
    // RÉELS (serverId + arguments documentés) — injectés après les sections
    // connecteurs/API pour que le planificateur les utilise à bon escient.
    mcpNote ?? "",
    "Réponds UNIQUEMENT avec l'objet JSON conforme au schéma.",
  ]
    .filter(Boolean)
    .join("\n");
  const metaSections = [
    meta?.evolutionContext,
    meta?.runHistoryContext,
    meta?.languageDirective,
    meta?.complexity
      ? `COMPLEXITÉ DE LA DEMANDE : score ${meta.complexity.score}/100 (niveau ${meta.complexity.level})${meta.complexity.beyondMastered ? " — au-delà du niveau déjà maîtrisé : MODE ÉVOLUTION activé, planifie plus finement, vérifie chaque étape, utilise de vrais outils et délègue à des sous-agents si nécessaire." : " — planifie en conséquence, sans étapes superflues."}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return metaSections ? `${base}\n${metaSections}` : base;
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
  /** Mode d'autorisation HITL choisi dans le composer (« Toujours demander ▼ »). */
  authorizationMode?: AuthorizationMode;
  /** Task 141 — agent dédié choisi dans le composer (sélecteur Gen IA ⇄ agents). */
  agentId?: string;
  /** Fuseau horaire du client (IANA) pour les tâches planifiées créées en langage naturel. */
  timezone?: string;
  /** Émetteur d'événements de flux (streaming NDJSON) — absent = API classique. */
  onEvent?: StreamEventEmitter;
}

/**
 * Task 141 — contexte d'agent dédié résolu pour un tour : charte injectée au
 * prompt système + préférences de modèle (uniquement si l'utilisateur n'a pas
 * fait un choix explicite dans le composer — le composer gagne toujours).
 */
export interface AgentTurnContext {
  id: string;
  name: string;
  charter: string;
  provider?: string;
  model?: string;
}

/** Charge l'agent dédié d'un tour (null silencieux : agent inconnu/inactif). */
async function loadTurnAgent(userId: string, agentId: string): Promise<AgentTurnContext | null> {
  try {
    const record = await getAgentForUser(userId, agentId);
    if (!record || record.status !== "active") return null;
    return {
      id: record.id,
      name: record.name,
      charter: buildAgentCharter(record),
      provider: record.modelStrategy === "fixed" ? record.preferredProvider : undefined,
      model: record.modelStrategy === "fixed" ? record.preferredModel : undefined,
    };
  } catch {
    // Agent illisible (stockage indisponible…) : repli silencieux sur Gen IA
    // universel — le tour ne doit JAMAIS échouer pour un sélecteur.
    return null;
  }
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

function historyForModel(history: ChatMessage[], limit = 16) {
  return history.slice(-limit).map((m) => ({ role: m.role, content: m.content }));
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

/**
 * Task 131 — budget de la fenêtre de contexte du tour conversationnel.
 * 24 000 tokens : cohérent avec l'usage LLM du projet (les modèles routés par
 * lib/ai/router acceptent 32k+ ; la marge restante couvre la réponse). En
 * dessous de ce budget, le comportement du moteur reste EXACTEMENT celui
 * d'avant (les 16 derniers messages) — la fenêtre glissante ne s'active que
 * lorsque l'historique déborde réellement du budget.
 */
const CONTEXT_WINDOW_BUDGET_TOKENS = 24_000;

/** Contexte des pièces jointes injecté au modèle (liste) + détails de conversion réelle. */
function attachmentsContext(attachments?: MessageAttachment[]): string {
  if (!attachments || attachments.length === 0) return "";
  const lines = attachments.map((a) => {
    const details = [
      a.contentType ? `(${a.contentType})` : "",
      a.fileKind ? `conversion réelle : ${a.fileKind}` : "",
      a.rowCount !== undefined ? `${a.rowCount} lignes` : "",
      a.charCount !== undefined ? `${a.charCount} caractères stockés en base` : "",
    ]
      .filter(Boolean)
      .join(", ");
    return `- ${a.filename}${details ? ` — ${details}` : ""}`;
  });
  return `\n\nPièces jointes de l'utilisateur :\n${lines.join("\n")}`;
}

export async function runConversationTurn(input: ConversationTurnInput): Promise<ConversationTurnResult> {
  // L'émetteur est enveloppé : une erreur de flux (client déconnecté…) ne
  // doit jamais interrompre le tour ni la persistance serveur.
  const onEvent = safeEmitter(input.onEvent);
  const conversation: ChatConversation | null = await getConversation(input.userId, input.conversationId);
  if (!conversation) throw new Error("Conversation introuvable.");

  // Task 141 — agent dédié choisi dans le composer : la charte de l'agent
  // (persona, compétences, garde-fous) est injectée au tour de chat et ses
  // préférences de modèle s'appliquent SAUF si l'utilisateur a fait un choix
  // explicite (le sélecteur de modèle du composer gagne toujours). Un agent
  // introuvable/inactif ne bloque JAMAIS le tour : repli sur Gen IA.
  const agent = input.agentId ? await loadTurnAgent(input.userId, input.agentId) : null;
  if (agent && !input.provider && agent.provider) {
    input = { ...input, provider: agent.provider, model: input.model ?? agent.model };
  }

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

  // Ordre "recent" : les PLUS RÉCENTS d'abord (puis réordonnés chrono).
  // Sur une conversation longue, l'ordre "asc" livrait au modèle les tout
  // premiers échanges et tronquait la fin du fil — l'agent « oubliait ».
  const history = await listMessages(input.userId, input.conversationId, 100, { order: "recent" });
  const priorHistory = history.slice(0, -1);

  // 1 bis) Fourniture d'une API personnelle dans le chat : le connecteur est
  // RÉELLEMENT créé (Firestore) et confirmé — la configuration reprend
  // exactement ce que l'utilisateur a écrit, rien n'est inventé.
  const provisioning = detectApiProvisioning(input.message);
  if (provisioning) {
    const result = await runApiProvisioningTurn({ ...input, conversation, project, projectId, userMessage, priorHistory, provisioning });
    await onEvent({
      type: "done",
      assistantMessage: result.assistantMessage,
      artifacts: result.artifacts,
      approvals: result.approvals,
    });
    return result;
  }

  // 1 bis-2) Sous-services sous autorité de l'agent IA : tâches planifiées,
  // workflows et pilotage (lister, activer, exécuter, supprimer) — détectés
  // DÉTERMINISTEMENT dans le langage naturel, exécutés via les outils RÉELS
  // (mêmes services que le Studio). Aucune invention : ce qui est créé en
  // base reprend exactement la demande.
  const baseCtx: TurnBase = { ...input, conversation, project, projectId, userMessage, priorHistory, agent };
  const controle = detectServiceControlIntent(input.message);
  if (controle) {
    const result = await runServiceControlTurn(baseCtx, controle);
    await onEvent({
      type: "done",
      assistantMessage: result.assistantMessage,
      artifacts: result.artifacts,
      approvals: result.approvals,
      ...(result.run ? { run: result.run } : {}),
    });
    return result;
  }
  const scheduleIntent = detectScheduleIntent(input.message);
  if (scheduleIntent) {
    const result = await runScheduleIntentTurn(baseCtx, scheduleIntent);
    await onEvent({
      type: "done",
      assistantMessage: result.assistantMessage,
      artifacts: result.artifacts,
      approvals: result.approvals,
    });
    return result;
  }
  const workflowIntent = detectWorkflowIntent(input.message);
  if (workflowIntent) {
    const result = await runWorkflowIntentTurn(baseCtx, workflowIntent);
    await onEvent({
      type: "done",
      assistantMessage: result.assistantMessage,
      artifacts: result.artifacts,
      approvals: result.approvals,
    });
    return result;
  }

  // 1 ter) API personnelles activées (base du planificateur + gardes).
  let customApis: CustomApiRecord[] = [];
  try {
    customApis = await listEnabledCustomApis(input.userId, 12);
  } catch {
    customApis = [];
  }
  // Les sélecteurs « api-<id> » activent une API personnelle — ils ne sont
  // PAS des toolkits Composio et ne doivent pas rejoindre cette section.
  const composioConnectors = (input.connectors ?? []).filter((slug) => !slug.startsWith("api-"));
  const hasSelectedApis = (input.connectors ?? []).some((slug) => slug.startsWith("api-"));

  // Task 143 — axe 4 : serveurs MCP ACTIFS de l'utilisateur (outils réels +
  // arguments documentés) injectés au classifieur d'intention — le
  // planificateur workspace voit les mêmes capacités que le chat agent.
  const mcpNote = await describeServersForPrompt(input.userId).catch(() => undefined);

  // 1 quater) Contenu RÉEL des fichiers importés (conversion stockée en base).
  // Deux budgets : raccourci pour la classification (latence), complet pour
  // la réponse (le modèle répond sur la pleine teneur).
  const filesContext = await loadImportedFilesContext(input.userId, input.attachments).catch(() => "");
  const filesContextShort = await loadImportedFilesContext(input.userId, input.attachments, { perFile: 2_500, total: 6_000 }).catch(() => "");

  // 1 septies) Analyse RÉELLE des médias joints (audio/vidéo) : transcript
  // (Scribe) + description (vision/FFmpeg) injectés au tour — « analyse
  // cette vidéo / cet audio » fonctionne enfin. Fail-soft TOTAL (jamais
  // bloquant), plafonné à 2 médias, les images gardant la voie vision
  // native (imagesForModel).
  // ANALYSE MÉDIA (vision) : les modèles de perception externes ont été SUPPRIMÉS
  // du projet (seules des IA externes devaient disparaître) — aucune
  // description fabriquée : les pièces jointes restent des fichiers.
  const mediaAnalysisContext = "";

  // 1 quinquies) Contenu RÉEL des liens fournis par l'utilisateur (étape 13) :
  // une URL collée dans la conversation est RÉELLEMENT récupérée (web.open,
  // pipeline sécurisé) et injectée — le modèle lit la page au lieu d'inventer.
  // L'URL déjà routée vers l'appel d'API direct (web.api) est exclue : ce
  // chemin la traite lui-même.
  const directUrl = extractApiUrlFromMessage(input.message);
  const webContext = await loadWebPageContext(input.message, {
    userId: input.userId,
    projectId: input.projectId,
    skipUrls: directUrl ? [directUrl] : [],
  }).catch(() => "");
  const webContextShort = webContext.slice(0, 6_000);

  // 1 sexies) Knowledge du projet (étape 15) : quand la conversation porte
  // sur un projet, les fragments les plus pertinents des documents indexés
  // sont recherchés AUTOMATIQUEMENT sur le message — plus besoin de planifier
  // knowledge.search pour que l'agent connaisse ses documents. Budget temps
  // serré : la recherche ne doit jamais ralentir un tour simple.
  const knowledgeContext = await (async () => {
    if (!input.projectId || !shouldSearchKnowledge({ projectId: input.projectId, message: input.message })) return "";
    try {
      const orgIds = await withTimeout(resolveKnowledgeScope(input.userId), 4_000, "scope knowledge").catch(() => [] as string[]);
      const results = await withTimeout(searchKnowledge(input.userId, input.projectId, input.message, 6, orgIds), 4_000, "recherche knowledge");
      return buildKnowledgeContext(results);
    } catch {
      return ""; // knowledge indisponible : le tour continue sans (jamais bloquant)
    }
  })();

  // 2) Demande d'image : ÉDITION d'une image existante (jointe ou générée
  // plus tôt) d'abord — sinon GÉNÉRATION réelle (Agnes AI) + artefact image.
  // Deux détections déterministes (aucune variance LLM) : verbe + nom
  // visuel, ou verbe de dessin explicite (« Dessine-moi un chat »).
  const lastConversationImage = findLastConversationImage(priorHistory);
  if (shouldRouteImageEdit(input.message, {
    hasImageAttachment: hasImageAttachment(input.attachments),
    hasConversationImage: Boolean(lastConversationImage),
  })) {
    await onEvent({ type: "status", phase: "image", label: "Édition de l'image en cours…" });
    const result = await runImageEditTurn({ ...input, conversation, project, projectId, userMessage, priorHistory }, lastConversationImage);
    await onEvent({
      type: "done",
      assistantMessage: result.assistantMessage,
      artifacts: result.artifacts,
      approvals: result.approvals,
    });
    return result;
  }
  if (looksLikeImageRequest(input.message) || looksLikeExplicitDrawingRequest(input.message)) {
    await onEvent({ type: "status", phase: "image", label: "Génération de l'image en cours…", stage: "generating", percent: 10 });
    const result = await runImageTurn({ ...input, conversation, project, projectId, userMessage, priorHistory });
    await onEvent({
      type: "done",
      assistantMessage: result.assistantMessage,
      artifacts: result.artifacts,
      approvals: result.approvals,
    });
    return result;
  }

  // 2 quater) DEMANDE DE VIDÉO : production COMPLÈTE autopilotée (file
  // `videoProductionJobs`) — création du projet, plan du réalisateur,
  // scénario, visuels de scènes, voix, montage et rendu, une étape par tick
  // QStash (repli : continuation par sondage). L'utilisateur suit la
  // progression RÉELLE dans la conversation (artefact vidéo) et dans
  // l'atelier vidéo.
  // Task 135 — CLARIFICATION VIDÉO (amélioration #1) : si l'utilisateur
  // RÉPOND à une question 🔄 posée après une demande de vidéo, la production
  // démarre avec le BRIEF RECOMPOSÉ (origine + précision) — les paramètres
  // (durée « 30 secondes », effets, sous-titres, format…) sont lus dans le
  // texte complet, sans repasser par le classifieur.
  const clarifiedVideo = resolveClarifiedObjective(input.message, priorHistory);
  if (clarifiedVideo && looksLikeVideoRequest(clarifiedVideo.originalRequest)) {
    await onEvent({ type: "status", phase: "execution", label: "Lancement de la production vidéo (demande précisée)…" });
    const composedPrompt = `${clarifiedVideo.originalRequest} ${input.message.trim()}`;
    const result = await runVideoTurn({ ...input, conversation, project, projectId, userMessage, priorHistory }, { effectivePrompt: composedPrompt });
    await onEvent({
      type: "done",
      assistantMessage: result.assistantMessage,
      artifacts: result.artifacts,
      approvals: result.approvals,
    });
    return result;
  }
  if (looksLikeVideoRequest(input.message)) {
    await onEvent({ type: "status", phase: "execution", label: "Lancement de la production vidéo…" });
    const result = await runVideoTurn({ ...input, conversation, project, projectId, userMessage, priorHistory });
    await onEvent({
      type: "done",
      assistantMessage: result.assistantMessage,
      artifacts: result.artifacts,
      approvals: result.approvals,
    });
    return result;
  }

  // (voix-off supprimée : TTS externe retiré du projet)

  // 2 bis) ARTEFACTS — création d'une page web / petite application :
  // le moteur produit un artefact HTML complet + un LIEN WEB (/preview/<id>)
  // qui rend le résultat directement dans le navigateur du client.
  const appIntent = detectAppCreationIntent(input.message);
  if (appIntent) {
    await onEvent({ type: "status", phase: "execution", label: "Génération de votre application…" });
    const result = await runAppTurn({ ...input, conversation, project, projectId, userMessage, priorHistory, filesContext }, appIntent);
    await onEvent({
      type: "done",
      assistantMessage: result.assistantMessage,
      artifacts: result.artifacts,
      approvals: result.approvals,
    });
    return result;
  }

  // 2 ter) ARTEFACTS — graphique d'analyse de données : données réelles
  // (fichier importé ou énoncées dans le message) → artefact graphique
  // exécutable (export PNG/JPG intégré) + conclusions.
  const chartIntent = detectChartIntent(input.message);
  if (chartIntent) {
    await onEvent({ type: "status", phase: "execution", label: "Analyse de vos données…" });
    const result = await runChartTurn({ ...input, conversation, project, projectId, userMessage, priorHistory, filesContext }, chartIntent);
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

  // AUTO-AMÉLIORATION + AMÉLIORATION DU PROMPT (demandes utilisateur) :
  // historique d'exécution réel, leçons apprises, évaluation de complexité,
  // puis optimisation du prompt (intention d'origine intangible, repli
  // silencieux — jamais bloquant ni lent).
  const [evolution, runHistory] = await Promise.all([
    buildEvolutionContext(input.userId).catch(() => ({ context: "", masteredMaxScore: 0 })),
    buildRunHistoryContext(input.userId, conversation.id).catch(() => ""),
  ]);
  const complexity = assessComplexity(input.message, evolution.masteredMaxScore);
  const enhancement = await enhancePromptForExecution({ userId: input.userId, message: input.message }).catch(() => ({ original: input.message, enhanced: input.message, improved: false, reason: "repli" }));

  // Task 135 — SUIVI CONTEXTUEL des clarifications : si l'utilisateur
  // RÉPOND à une question 🔄 Précision posée au tour précédent, la note de
  // contexte rappelle la demande d'origine au classifieur d'intention — la
  // réponse est traitée comme l'information manquante, jamais comme un
  // nouveau sujet isolé. (clarifiedVideo est déjà calculé en amont —
  // raccourci vidéo de la cascade d'intercepts.)
  const clarificationFollowUp = clarifiedVideo;
  const clarificationFollowNote = clarificationFollowUp
    ? `\n\n[CONTEXTE DE CLARIFICATION : l'utilisateur répond à votre question « ${clarificationFollowUp.question.slice(0, 200)} » posée au tour précédent. Demande d'origine : « ${clarificationFollowUp.originalRequest.slice(0, 400)} ». Sa réponse EST l'information manquante — exécutez la demande COMPLETE (origine + précision), ne re-demandez pas cette information.]`
    : "";

  await onEvent({ type: "status", phase: "intention", label: "Analyse de votre demande…" });
  let intent: TurnIntent;
  try {
    const result = await withTimeout(
      runAIJSON({
        userId: input.userId,
        feature: "conversation-turn",
        task: "chat",
        system: buildIntentSystemPrompt(catalog, project, composioConnectors, customApis, {
          evolutionContext: evolution.context,
          runHistoryContext: runHistory,
          complexity,
          languageDirective: languageDirective(input.message),
        }, mcpNote),
        prompt:
          `Historique récent :\n${priorHistory.slice(-6).map((m) => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content.slice(0, 500)}`).join("\n") || "(vide)"}` +
          `\n\nNouvelle demande (optimisée par le système d'amélioration de prompts — demande d'origine intangible : « ${enhancement.original.slice(0, 400)} ») : ${enhancement.enhanced.slice(0, 4000)}${attachmentsContext(input.attachments)}${filesContextShort}${webContext ? `\n\nContenu réel des liens fournis (résumé) :${webContextShort}` : ""}${clarificationFollowNote}`,
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

  // Canal de CLARIFICATION (Task 135 — compréhension EXACTE) : le
  // classifieur a détecté une incompréhension possible — une seule question
  // précise est posée, MARQUÉE 🔄 (suivi contextuel au tour suivant), avec
  // des suggestions cliquables si fournies. Le garde s'applique AUSSI au
  // mode "plan" (confiance basse ou ambiguïté haute AVANT une exécution
  // coûteuse), avec protection anti-boucle : une réponse à une clarification
  // ne redéclenche JAMAIS le garde déterministe.
  let clarifyQuestion = intent.needsClarification && intent.clarifyingQuestion?.trim() ? intent.clarifyingQuestion.trim() : undefined;
  let clarifySuggestions = intent.suggestions;
  if (
    !clarifyQuestion &&
    !clarificationFollowUp &&
    intent.mode === "plan" &&
    (typeof intent.confidence === "number" ? intent.confidence < 0.55 : false)
  ) {
    const signals = detectAmbiguitySignals(input.message);
    clarifyQuestion =
      deterministicClarifyingQuestion(signals, input.message) ??
      `Je veux être sûr de bien comprendre votre demande avant d'agir : pouvez-vous préciser ce que vous attendez exactement (action, livrable, contexte) ? Voici ce que j'ai compris pour l'instant : « ${input.message.trim().slice(0, 140)} ».`;
    clarifySuggestions = undefined;
  }
  if (clarifyQuestion) {
    await onEvent({ type: "status", phase: "intention", label: "Clarification de votre demande…" });
    const suggestionsBlock = clarifySuggestions && clarifySuggestions.length > 0
      ? "\n\nVous pouvez répondre directement, ou choisir :\n" + clarifySuggestions.map((s) => `- ${s}`).join("\n")
      : "";
    const assistantMessage = await appendMessage({
      conversationId: input.conversationId,
      userId: input.userId,
      role: "assistant",
      content: markClarification(clarifyQuestion) + suggestionsBlock,
      generationStatus: "complete",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    const clarifyResult: ConversationTurnResult = {
      conversationId: input.conversationId,
      userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent,
    };
    await onEvent({
      type: "done",
      assistantMessage: clarifyResult.assistantMessage,
      artifacts: clarifyResult.artifacts,
      approvals: clarifyResult.approvals,
    });
    return clarifyResult;
  }

  if (intent.mode === "chat") {
    // Garde-fou : la demande exige explicitement un outil réel ?
    const explicit = detectExplicitToolIntent(input.message, catalog, customApis);
    if (!explicit && hasSelectedApis) {
      // API personnelle activée via le sélecteur pour CE message : appel réel attendu.
      const selectedApi = customApis.find((api) => (input.connectors ?? []).includes(`api-${api.id}`));
      if (selectedApi) {
        intent = {
          mode: "plan",
          understanding: "API personnelle activée pour ce message : appel réel attendu.",
          objective: input.message.slice(0, 400),
          steps: [
            {
              title: `Appel de l'API « ${selectedApi.name} »`,
              detail: "Appel HTTP réel vers l'API personnelle activée par l'utilisateur (exécution serveur).",
              toolName: "custom_api.call",
              toolInput: { apiName: selectedApi.name, path: extractApiPathFromMessage(input.message) ?? "" },
            },
          ],
        };
      }
    }
    if (explicit?.toolName === "web.search") {
      intent = {
        mode: "plan",
        understanding: "Demande explicite d'actions réelles (recherche web).",
        objective: input.message.slice(0, 400),
        steps: [
          {
            title: "Recherche web",
            detail: "Recherche réelle sur le web demandée explicitement par l'utilisateur.",
            toolName: explicit.toolName,
            toolInput: { query: explicit.query, maxResults: 8 },
          },
        ],
      };
    } else if (explicit?.toolName === "custom_api.call") {
      intent = {
        mode: "plan",
        understanding: "Appel réel d'une API personnelle demandé explicitement.",
        objective: input.message.slice(0, 400),
        steps: [
          {
            title: "Appel de votre API",
            detail: "Appel HTTP réel vers l'API personnelle de l'utilisateur (exécution serveur).",
            toolName: "custom_api.call",
            toolInput: { apiName: extractApiUsageName(input.message) ?? undefined, path: extractApiPathFromMessage(input.message) ?? "" },
          },
        ],
      };
    } else if (explicit?.toolName === "web.api.write") {
      // ÉCRITURE API explicite : méthode + corps énoncés, routés vers
      // web.api.write (validation humaine si l'app n'est pas connectée).
      intent = {
        mode: "plan",
        understanding: "Modification de données via une API désignée par URL (écriture réelle).",
        objective: input.message.slice(0, 400),
        steps: [
          {
            title: `Écriture via l'API (${explicit.method})`,
            detail: `Requête ${explicit.method} réelle vers l'API publique désignée par l'utilisateur (exécution serveur).`,
            toolName: "web.api.write",
            toolInput: { url: explicit.url, method: explicit.method, ...(explicit.body ? { body: explicit.body } : {}) },
          },
        ],
      };
    } else if (explicit?.toolName === "web.api") {
      intent = {
        mode: "plan",
        understanding: "Appel réel d'une API désignée par URL demandé explicitement.",
        objective: input.message.slice(0, 400),
        steps: [
          {
            title: "Appel de l'API",
            detail: "Appel HTTP réel vers l'API publique désignée par l'utilisateur (exécution serveur).",
            toolName: "web.api",
            toolInput: { url: explicit.url },
          },
        ],
      };
    } else if (explicit?.toolName === "email.send") {
      // Envoi d'email explicite : un seul step — l'envoi réel est exécuté par
      // le serveur via le service email de la plateforme (Resend).
      intent = {
        mode: "plan",
        understanding: "Demande explicite d'envoi d'un email réel.",
        objective: input.message.slice(0, 400),
        steps: [
          {
            title: `Envoi de l'email à ${explicit.to}`,
            detail: "Envoi réel du message via le service email de la plateforme (Resend).",
            toolName: "email.send",
            toolInput: { to: explicit.to, subject: explicit.subject, text: explicit.text },
          },
        ],
      };
    } else if (explicit?.toolName === "artifact.create") {
      // Livrable document explicite : plan en deux temps — la rédaction du
      // contenu est finalisée par le moteur (ensureArtifactInput), puis
      // artifact.create produit le fichier réel (pdf/docx/xlsx/pptx).
      intent = {
        mode: "plan",
        understanding: "Demande explicite d'un livrable document téléchargeable.",
        objective: input.message.slice(0, 400),
        steps: [
          {
            title: `Rédaction du contenu (${explicit.document.format})`,
            detail: "Rédige un contenu structuré et complet pour le document demandé.",
          },
          {
            title: `Création du document « ${explicit.document.title} »`,
            detail: "Génère le fichier téléchargeable et le range dans les livrables de la conversation.",
            toolName: "artifact.create",
            toolInput: { title: explicit.document.title, format: explicit.document.format },
          },
        ],
      };
    }
  }
  if (intent.mode === "chat") {
    // Skills auto-attribuées : la demande de l'utilisateur sélectionne
    // (déterministe, fail-soft) les skills pertinentes de la bibliothèque
    // (skills.sh + plateforme) — injectées comme instructions de mission.
    let skillsSection: string | undefined;
    try {
      const { selectSkillsForObjective, formatSkillsSection } = await import("@/lib/skills/runtime-bridge");
      const skillsBlock = await selectSkillsForObjective({ userId: input.userId, objective: input.message });
      skillsSection = formatSkillsSection(skillsBlock) || undefined;
    } catch {
      skillsSection = undefined;
    }
    const result = await runChatTurn({ ...input, conversation, project, projectId, userMessage, priorHistory, intent, filesContext, webContext, knowledgeContext, mediaAnalysisContext, skillsSection });
    await onEvent({
      type: "done",
      assistantMessage: result.assistantMessage,
      artifacts: result.artifacts,
      approvals: result.approvals,
    });
    return result;
  }
  const result = await runPlanTurn({ ...input, conversation, project, projectId, userMessage, priorHistory, intent, filesContext, complexityScore: complexity.score });
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
  /** Task 141 — agent dédié résolu pour ce tour (null = Gen IA universel). */
  agent?: AgentTurnContext | null;
  /** Contenu réel des fichiers importés (convertis + stockés en base). */
  filesContext?: string;
  /** Contenu réel des liens fournis par l'utilisateur (pages récupérées). */
  webContext?: string;
  /** Fragments pertinents de la base de connaissances du projet. */
  knowledgeContext?: string;
  /** Analyse RÉELLE des médias (audio/vidéo) joints au message courant. */
  mediaAnalysisContext?: string;
  /** Score de complexité évalué par le système d'auto-amélioration. */
  complexityScore?: number;
  /** Skills auto-attribuées pour ce tour (sélection par la demande). */
  skillsSection?: string;
}

interface TurnContext extends TurnBase {
  intent: TurnIntent;
}

async function runChatTurn(ctx: TurnContext): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  const streaming = Boolean(ctx.onEvent);
  // Task 141 — agent dédié : quand l'utilisateur a choisi un agent dans le
  // composer, la charte de CET agent prime sur l'identité universelle (nom,
  // mission, compétences, persona, garde-fous) — les règles de plateforme
  // (formats, médias, honnêteté) restent inchangées et prévalent en dernier.
  const identityPart = ctx.agent
    ? `Tu réponds actuellement sous l'identité de l'agent dédié « ${ctx.agent.name} ». La charte de cet agent prime sur ton identité par défaut — respecte son ton, son périmètre et ses garde-fous tout en gardant toutes tes capacités d'exécution :\n\n${ctx.agent.charter}`
    : "Tu es Gen IA, l'agent IA universel de Gen3ia, capable de tout réaliser : tu réponds de façon directe, structurée et actionnable. Pour une tâche très complexe, tu peux déployer jusqu'à 10 sous-agents spécialisés (orchestration).";
  const systemParts = [
    identityPart,
    // Task 52 : contrat de présentation visible (clarté, précision selon le
    // sujet saisi, structure markdown, zéro invention) — aligné sur l'exigence
    // « qualité ChatGPT à chaque requête ».
    RESPONSE_FORMAT_RULES,
    // Compréhension exacte : répondre dans la LANGUE du dernier message.
    languageDirective(ctx.message),
    "La génération d'IMAGES, la production de VIDÉOS, la synthèse d'AUDIOS (voix-off ElevenLabs) et l'analyse de médias sont effectuées par la plateforme Gen3ia, jamais par toi dans cette réponse : ne prétends JAMAIS avoir généré un média comme s'il était affiché, et n'invente jamais d'URL.",
    "POLITIQUE UNIVERSELLE (impérative) : la plateforme prend en charge TOUS les types de génération — ne dis JAMAIS qu'elle « ne prend en charge que les images », « ne fait pas d'audio » ou qu'une capacité manque. Si la production n'a pas été déclenchée automatiquement, demande les éléments manquants (ex : le TEXTE à faire entendre pour un audio) ou oriente vers la relance — ne propose JAMAIS un service externe ni un tutoriel à la place d'une capacité de la plateforme.",
    ctx.project?.instructions ? `Instructions du projet « ${ctx.project.name} » :\n${ctx.project.instructions}` : "",
    ctx.project?.privacyRules ? `Règles de confidentialité impératives :\n${ctx.project.privacyRules}` : "",
    // Skills auto-attribuées (skills.sh + plateforme) : sélection déterministe
    // par la demande utilisateur — fail-soft, absent si aucune ne matche.
    ctx.skillsSection ?? "",
    ctx.filesContext ? `Ces contenus proviennent de fichiers importés par l'utilisateur (conversion réelle stockée en base de données) — appuie-toi EXCLUSIVEMENT sur eux pour toute question les concernant, sans jamais inventer de données :${ctx.filesContext}` : "",
    ctx.mediaAnalysisContext ?? "",
    ctx.webContext ? `Ces contenus proviennent de liens fournis par l'utilisateur — pages RÉELLEMENT récupérées par la plateforme au moment de la demande. Appuie-toi sur eux pour toute question les concernant, cite-les fidèlement, et ne complète JAMAIS par une invention de leur contenu :${ctx.webContext}` : "",
    ctx.knowledgeContext ? `Ces extraits proviennent de la BASE DE CONNAISSANCES du projet (documents indexés par l'utilisateur) — cite-les fidèlement quand ils répondent à la demande et ne complète JAMAIS par une invention de leur contenu :${ctx.knowledgeContext}` : "",
  ].filter(Boolean);

  // VISION : les images réellement jointes au message sont transmises aux
  // modèles vision (parts image_url / blocs image selon le provider) —
  // « que voit-on sur cette photo ? » fonctionne enfin.
  const visionImages = imagesForModel(ctx.attachments);
  // Task 131 — fenêtre glissante de contexte : en dessous du budget, le
  // comportement est STRICTEMENT identique à l'ancien slice des 16 derniers
  // messages (aucune régression pour les conversations courtes). Au-delà, la
  // fenêtre préserve le prompt système (jamais tronqué), les messages les
  // plus récents, l'intention d'origine (premier message utilisateur si
  // possible) et remplace les messages évacués par un résumé déterministe
  // injecté comme message système additionnel (zéro LLM, zéro latence).
  const systemContent = systemParts.join("\n\n");
  const recentHistory = historyForModel(ctx.priorHistory);
  const turnTokens =
    estimateTokens(systemContent) +
    estimateTokens(ctx.message) +
    recentHistory.reduce((somme, message) => somme + estimateTokens(message.content), 0);
  let historyMessages = recentHistory;
  let summaryPrefix: string | undefined;
  if (turnTokens > CONTEXT_WINDOW_BUDGET_TOKENS) {
    const window = buildContextWindow({
      systemPrompt: systemContent,
      history: ctx.priorHistory,
      // La place du message courant est réservée au budget de la fenêtre
      // (plancher 2 000 : un message très long ne doit pas vider la fenêtre).
      budgetTokens: Math.max(2_000, CONTEXT_WINDOW_BUDGET_TOKENS - estimateTokens(ctx.message)),
    });
    historyMessages = window.messages.map((message) => ({ role: message.role, content: message.content }));
    summaryPrefix = window.summaryPrefix;
  }
  const requestMessages = [
    ...(systemParts.length > 0
      ? [{ role: "system" as const, content: systemContent }]
      : []),
    ...(summaryPrefix ? [{ role: "system" as const, content: summaryPrefix }] : []),
    ...historyMessages,
    { role: "user" as const, content: ctx.message, ...(visionImages ? { images: visionImages } : {}) },
  ];

  let content: string;
  let provider: string | undefined;
  let model: string | undefined;
  let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
  let generationStatus: "complete" | "failed" = "complete";

  if (streaming) {
    // Streaming réel : chaque fragment est transmis au client au fil de
    // l'arrivée ; le texte complet est ensuite persisté d'un bloc.
    // Filtrage anti-balises de raisonnement (<think>…) : le client ne voit
    // JAMAIS la balise, même coupée entre deux fragments (machine à états).
    const thinkFilter = new ThinkTagStreamFilter();
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
            preferFree: preferFreeForVisibleAnswers(),
            metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
          },
          {
            onDelta: (delta) => {
              const visible = thinkFilter.push(delta);
              if (!visible) return;
              streamedText += visible;
              return onEvent({ type: "message_delta", delta: visible });
            },
          },
        ),
        CHAT_BUDGET_MS,
        "réponse conversationnelle",
      );
      content = stripThinkTags(response.text);
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
              preferFree: preferFreeForVisibleAnswers(),
              metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
            }),
            CHAT_BUDGET_MS,
            "réponse conversationnelle",
          );
          content = stripThinkTags(response.text);
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
          preferFree: preferFreeForVisibleAnswers(),
          metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
        }),
        CHAT_BUDGET_MS,
        "réponse conversationnelle",
      );
      content = stripThinkTags(response.text);
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

  // Garde : une réponse vide (fournisseur défaillant) ne doit jamais être
  // persistée telle quelle — l'utilisateur verrait une bulle fantôme.
  if (!content || !content.trim()) {
    content =
      "Je n'ai pas réussi à produire une réponse dans le délai imparti (le fournisseur IA est surchargé). " +
      "Réessayez en renvoyant votre message — il reste dans la conversation.";
    provider = "gen3ia";
    generationStatus = "failed";
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
    // Task 141 — traçabilité de l'agent dédié du tour + suggestions de
    // suivi cliquables (heuristique déterministe, cf. follow-ups.ts).
    ...(ctx.agent ? { agentId: ctx.agent.id, agentName: ctx.agent.name } : {}),
    ...(generationStatus === "complete" ? { suggestions: buildFollowUpSuggestions(ctx.message, content) } : {}),
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
/* Tour « image » — génération réelle (Agnes AI) + artefact            */
/* ------------------------------------------------------------------ */

/**
 * Compétence image Gen3ia : le prompt de l'utilisateur est analysé puis
 * amélioré par LLM (sujet INTACT, rendu optimisé ultra réaliste), puis la
 * génération réelle est déléguée à Agnes AI en 2K (détail supérieur).
 * L'amélioration n'est JAMAIS bloquante (repli : prompt d'origine) et la
 * durée totale reste sous le budget de la fonction serverless (60 s).
 *
 * Persistance (Task 45) : l'URL d'Agnes est TEMPORAIRE — l'image est donc
 * copiée dans le stockage de l'utilisateur (R2, chemin « permanent »
 * compatible avec /api/storage/permanent) ou, sans R2 et si la taille le
 * permet, inline en data URI. Le téléchargement reste possible après
 * expiration de l'URL d'origine.
 */
async function produceConversationImage(
  ctx: Pick<TurnContext, "message" | "userId">,
  plannedPrompt?: string,
  onProgress?: (event: { label: string; stage: string; percent: number }) => Promise<void> | void,
): Promise<{ imageUrl: string; model: string; storagePath?: string; inlineDataUrl?: string }> {
  const rawPrompt =
    typeof plannedPrompt === "string" && plannedPrompt.trim().length >= 3
      ? plannedPrompt.trim().slice(0, 4000)
      : extractImagePrompt(ctx.message);
  // Brief visuel déterministe (moteur local — sujet intact).
  await onProgress?.({ label: "Préparation du brief visuel…", stage: "enhance", percent: 15 });
  const prompt = enhanceImagePrompt(rawPrompt);
  await onProgress?.({ label: "Génération neuronale en cours…", stage: "generating", percent: 40 });
  // GÉNÉRATION NEURONALE LOCALE : les imageurs externes (Agnes/HF) ont été
  // SUPPRIMÉS du projet sur demande de l'utilisateur. La composition est
  // calculée par le moteur Gen3 depuis l'état réel du cerveau et archivée
  // en R2 permanent par le service média.
  const { genererVisuelNeuralEtPersister } = await import("@/lib/neural/media-service");
  const image = await genererVisuelNeuralEtPersister({
    userId: ctx.userId,
    prompt,
    ratio: detectImageRatio(ctx.message),
  });
  await onProgress?.({ label: "Enregistrement sécurisé de l'image…", stage: "persisting", percent: 80 });
  return { imageUrl: image.url, model: "gen3-snn-v1" };
}


/**
 * Dernière image exploitable de la conversation (édition sans pièce
 * jointe) : on scanne l'historique depuis la fin — un message assistant
 * portant une imageUrl (image générée) ou un message avec attachment image
 * pourvu d'une ressource (path R2 ou URL). Retourne null si aucune.
 */
function findLastConversationImage(history: ChatMessage[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message) continue;
    if (message.imageUrl && (message.imageUrl.startsWith("data:image/") || /^https?:\/\//i.test(message.imageUrl))) {
      return message.imageUrl;
    }
    for (const attachment of message.attachments ?? []) {
      const candidates = attachmentImageCandidates(attachment);
      if (candidates.length > 0) return candidates[0] as string;
    }
  }
  return null;
}

/**
 * Tour « ÉDITION d'image » (étape 8) : une image EXISTANTE — jointe au
 * message (import utilisateur) ou générée plus tôt dans la conversation —
 * est réellement modifiée via Agnes image-to-image. La source est résolue
 * en Data URI côté serveur (fiable), le résultat est persisté comme les
 * autres images (R2 / inline) et joint à un artefact. Échec = message
 * honnête dans le fil, jamais de faux succès.
 */
async function runImageEditTurn(ctx: TurnBase, lastConversationImage: string | null): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  try {
    const attachmentSources = (ctx.attachments ?? []).flatMap((attachment) => attachmentImageCandidates(attachment));
    const rawSources = attachmentSources.length > 0 ? attachmentSources : lastConversationImage ? [lastConversationImage] : [];
    if (rawSources.length === 0) {
      throw new Error(
        "Aucune image à éditer n'a été trouvée. Joignez l'image à votre message (📎) ou générez-en une d'abord, puis redemandez la modification.",
      );
    }
    const sources = await resolveEditableImageSources(rawSources);
    // ÉDITION PIXEL SUPPRIMÉE (modèle d'édition externe retiré) : la demande
    // est honorée par une RÉGÉNÉRATION neuronale locale intégrant la consigne
    // — honnête : composition recalculée, pas retouche pixel par pixel.
    const { genererVisuelNeuralEtPersister } = await import("@/lib/neural/media-service");
    const image = await genererVisuelNeuralEtPersister({
      userId: ctx.userId,
      prompt: ctx.message.trim().slice(0, 4000),
      ratio: detectImageRatio(ctx.message),
    });
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: "Voici votre nouvelle composition neuronale, recalculée avec votre consigne de modification. L'original reste disponible dans les artefacts de la conversation.",
      imageUrl: image.url,
      provider: "gen3-snn",
      model: "gen3-snn-v1",
      generationStatus: "complete",
    });
    const artifact = await createArtifact({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      type: "image",
      title: ctx.message.slice(0, 80),
      url: image.url,
      note: `Régénéré par le moteur neuronal Gen3 (${sources.length} source(s) conservée(s))`,
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    await onEvent({ type: "artifact_created", artifact });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [artifact],
      approvals: [],
      intent: { mode: "chat", understanding: "Demande d'édition d'une image existante." },
    };
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "L'édition d'image a échoué. Réessayez dans un instant.";
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: message,
      generationStatus: "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Demande d'édition d'une image existante." },
    };
  }
}

async function runImageTurn(ctx: TurnBase): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  try {
    // Progression RÉELLE émise par le serveur au fil des étapes réelles
    // (amélioration → génération → enregistrement) — cadre de progression
    // temps réel côté client (Task « cadre de progression »).
    const image = await produceConversationImage(ctx, undefined, async ({ label, stage, percent }) => {
      await onEvent({ type: "status", phase: "image", label, stage, percent });
    });
    await onEvent({ type: "status", phase: "image", label: "Image prête.", stage: "complete", percent: 100 });
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: "Voici l'image que j'ai générée pour vous. Elle est également enregistrée dans les artefacts de la conversation.",
      imageUrl: image.inlineDataUrl ?? image.imageUrl,
      provider: "gen3-snn",
      model: image.model,
      generationStatus: "complete",
    });
    const artifact = await createArtifact({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      type: "image",
      title: ctx.message.slice(0, 80),
      url: image.inlineDataUrl ?? image.imageUrl,
      storagePath: image.storagePath,
      note: `Généré par le moteur neuronal Gen3 (${image.model})`,
    });
    // Contrat de flux complet : le client doit recevoir la même séquence
    // d'événements que les autres tours (audit 25-a : message_complete et
    // artifact_created manquaient sur le tour image).
    await onEvent({ type: "message_complete", message: assistantMessage });
    await onEvent({ type: "artifact_created", artifact });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [artifact],
      approvals: [],
      intent: { mode: "chat", understanding: "Demande de génération d'image." },
    };
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "La génération d'image a échoué. Réessayez dans un instant.";
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: message,
      generationStatus: "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
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
/* Tour « vidéo » — production COMPLÈTE autopilotée + artefact suivi   */
/* ------------------------------------------------------------------ */

/**
 * La demande vidéo de l'utilisateur lance une PRODUCTION RÉELLE complète :
 * la file `videoProductionJobs` (lib/video/production-queue) enchaîne — une
 * étape par tick QStash (repli : continuation par sondage) — création du
 * projet, plan du réalisateur, scénario, visuels de scènes (Consistency
 * Engine, facturation image existante), narration vocale, musique, puis le
 * rendu FFmpeg avec contrôle qualité. La conversation reçoit IMMÉDIATEMENT
 * un artefact de type "video" portant projectId/jobId : le client sonde la
 * progression réelle (GET production) et affiche le rendu final.
 */
/**
 * Task 135 — tour vidéo après clarification : l'utilisateur a répondu à une
 * question 🔄 posée à la suite d'une demande de vidéo — la production est
 * lancée avec le BRIEF RECOMPOSÉ (demande d'origine + précision apportée),
 * les paramètres déterministes (durée, format, effets, sous-titres…) étant
 * lus dans le texte COMPLET.
 */
async function runVideoTurn(
  ctx: TurnBase,
  options: { effectivePrompt?: string } = {},
): Promise<ConversationTurnResult> {
  const promptText = options.effectivePrompt?.trim() || ctx.message;
  const onEvent = safeEmitter(ctx.onEvent);
  try {
    const { createVideoProductionJob } = await import("@/lib/video/production-queue");
    // Task 106-a — production OPTIMALE : durée, cadrage, plateforme et
    // formats dérivés sont lus DÉTERMINISTEMENT dans la demande (zéro LLM)
    // et relayés à la file de production (options validées côté pipeline).
    const params = extractVideoParams(promptText);
    const job = await createVideoProductionJob({
      userId: ctx.userId,
      prompt: promptText.trim().slice(0, 4000),
      title: extractVideoTitle(promptText),
      // Task 107-a — la conversation d'origine est PORTÉE PAR LE JOB : à la
      // complétion, le résultat est livré DANS ce fil (message + artefact)
      // même si l'utilisateur a fermé la page.
      conversationId: ctx.conversationId,
      ...(Object.keys(params).length > 0 ? { options: params } : {}),
    });
    const studioUrl = `/studio/video/${job.projectId}`;
    const paramsSummary = [
      params.targetDurationSec ? `durée cible ${Math.floor(params.targetDurationSec / 60) > 0 ? `${Math.floor(params.targetDurationSec / 60)} min ${params.targetDurationSec % 60 || ""}`.trim() : `${params.targetDurationSec} s`}` : null,
      params.aspectRatio ? `cadrage ${params.aspectRatio}` : null,
      params.platform ? `plateforme ${params.platform}` : null,
      params.derivedTargets?.length ? `formats dérivés (${params.derivedTargets.join(", ")})` : null,
      params.subtitlesEnabled === false ? "sans sous-titres" : params.subtitleStyle ? `sous-titres ${params.subtitleStyle === "karaoke_pop" ? "karaoké" : params.subtitleStyle}` : null,
      params.subtitlePosition ? `sous-titres positionnés ${params.subtitlePosition === "top" ? "en haut" : params.subtitlePosition === "center" ? "au centre" : "en bas"}` : null,
      params.effectPreset ? ({ none: "sans effets", subtle: "effets discrets", dynamic: "effets dynamiques", cinematic: "style cinématique", capcut: "studio CapCut" } as Record<string, string>)[params.effectPreset] ?? null : null,
    ].filter(Boolean).join(" · ");
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: [
        "Votre production vidéo est lancée" + (paramsSummary ? ` — ${paramsSummary}.` : "."),
        "Voici ce qui se passe maintenant, étape par étape :",
        "1. Plan du réalisateur et scénario complet (hook, chapitres, scènes, CTA) ;",
        "2. Génération des visuels de chaque scène avec un style cohérent ;",
        "3. Narration vocale, musique (ambiance adaptée) et montage multicam ;",
        "4. Rendu final avec contrôle qualité automatique (durée, audio, sous-titres)",
        params.derivedTargets?.length ? "5. Formats dérivés pour vos plateformes (TikTok/Shorts/Reels…)." : "",
        "",
        "Demandez-moi « où en est ma vidéo ? » à tout moment, ou des modifications (musique, rythme, pause…). Le cadre ci-dessous affiche la progression RÉELLE en temps réel — il se met à jour tout seul jusqu'à la vidéo finie. Le projet complet (timeline, versions, exports) est disponible dans l'atelier vidéo : " + studioUrl,
      ].filter(Boolean).join("\n"),
      generationStatus: "complete",
    });
    const artifact = await createArtifact({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      type: "video",
      title: extractVideoTitle(promptText),
      note: "Production vidéo autonome — progression en temps réel",
      videoProjectId: job.projectId,
      videoJobId: job.jobId,
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    await onEvent({ type: "artifact_created", artifact });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [artifact],
      approvals: [],
      intent: { mode: "chat", understanding: "Demande de production vidéo complète (autopilote lancé)." },
    };
  } catch (error) {
    const unavailable = error instanceof Error && /n.est pas disponible/.test(error.message);
    const message = unavailable
      ? "La production vidéo n'est pas disponible sur cette plateforme actuellement (moteur de production non configuré). Votre demande est conservée : réessayez plus tard ou depuis l'atelier vidéo."
      : "Le lancement de la production vidéo a échoué. Votre demande est conservée — réessayez dans un instant.";
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: message,
      generationStatus: "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Demande de production vidéo complète (échec du lancement)." },
    };
  }
}

/* ------------------------------------------------------------------ */
/* Tour « artefact application » — page web exécutable + lien d'aperçu */
/* ------------------------------------------------------------------ */

async function runAppTurn(ctx: TurnBase, appIntent: AppCreationIntent): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  const streaming = Boolean(ctx.onEvent);
  try {
    await onEvent({ type: "status", phase: "execution", label: "Conception de l'application…" });
    const requestMessages = [
      { role: "system" as const, content: APP_SYSTEM_PROMPT },
      { role: "user" as const, content: buildAppUserRequest(ctx.message, appIntent) },
    ];
    const response = await withTimeout(
      streaming
        ? generateStream(
            {
              task: "chat",
              messages: requestMessages,
              provider: ctx.provider as never,
              model: ctx.model,
              preferFree: preferFreeForVisibleAnswers(),
              maxTokens: 32_000,
              metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
            },
            {
              // Le flux d'une application n'est pas affiché token par token :
              // l'utilisateur voit la progression, puis l'aperçu complet.
              onDelta: () => undefined,
            },
          )
        : generate({
            task: "chat",
            messages: requestMessages,
            provider: ctx.provider as never,
            model: ctx.model,
            preferFree: preferFreeForVisibleAnswers(),
            maxTokens: 32_000,
            metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
          }),
      90_000,
      "génération de l'application",
    );
    const html = extractHtmlDocument(response.text);
    if (!html) {
      throw new Error("Le modèle n'a pas produit un document HTML complet — réessayez dans un instant.");
    }

    const artifact = await createArtifact({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      type: "code",
      title: appIntent.title,
      language: "html",
      filename: `${appIntent.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "application"}.html`,
      content: html,
      note: "Application web exécutable — aperçu en direct disponible",
    });
    await onEvent({ type: "artifact_created", artifact });

    const content = appendPreviewLinks(
      [
        `Votre application **${appIntent.title}** est prête et enregistrée dans les artefacts de la conversation.`,
        "Elle s'exécute telle quelle : cliquez sur le lien ci-dessous pour voir le rendu dans votre navigateur, ou utilisez le bouton « Voir le résultat en direct » dans le fil. Pour toute modification (« ajoute un filtre », « change les couleurs »), redemandez-le simplement : une nouvelle version sera publiée.",
      ].join("\n\n"),
      [artifact],
    );
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content,
      generationStatus: "complete",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [artifact],
      approvals: [],
      intent: { mode: "chat", understanding: "Création d'une application web (artefact + aperçu en direct)." },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "La génération de l'application a échoué.";
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: `Je n'ai pas réussi à générer l'application demandée (${message}). Réessayez en renvoyant votre message — rien n'a été perdu.`,
      generationStatus: "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Création d'une application web (échec de génération)." },
    };
  }
}

/* ------------------------------------------------------------------ */
/* Tour « analyse de données » — graphique réel + conclusions          */
/* ------------------------------------------------------------------ */

async function loadChartData(ctx: TurnBase): Promise<{ labels: string[]; values: number[]; source: string } | null> {
  // 1) Fichiers importés explicitement joints à CE message (conversion réelle).
  const fileIds = (ctx.attachments ?? []).map((a) => a.fileId).filter((id): id is string => Boolean(id));
  for (const fileId of fileIds) {
    const record = await getImportedFileContent(ctx.userId, fileId).catch(() => null);
    const structured = record?.structuredPreview;
    if (structured?.headers && structured?.rows) {
      const data = chartDataFromTable(structured.headers, structured.rows, `fichier importé « ${record?.filename ?? fileId} »`);
      if (data) return data;
    }
  }
  // 2) Derniers fichiers importés structurés de l'utilisateur (CSV/XLSX).
  const recent = await listImportedFiles(ctx.userId, 8).catch(() => []);
  for (const record of recent) {
    const full = await getImportedFileContent(ctx.userId, record.id).catch(() => null);
    const structured = full?.structuredPreview;
    if (structured?.headers && structured?.rows) {
      const data = chartDataFromTable(structured.headers, structured.rows, `fichier importé « ${full?.filename ?? record.filename} »`);
      if (data) return data;
    }
  }
  // 3) Données énoncées directement dans le message (« Ventes : 120, … »).
  return extractInlineData(ctx.message);
}

async function runChartTurn(ctx: TurnBase, chartIntent: ChartIntent): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  const data = await loadChartData(ctx);
  if (!data) {
    // Aucune donnée : réponse honnête, JAMAIS de données inventées.
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: [
        "Pour générer un graphique, j'ai besoin de données réelles. Deux façons de me les donner :",
        "1. **Importez un fichier** CSV ou Excel dans la conversation (je le convertis réellement puis je le visualise) ;",
        "2. **Écrivez les valeurs dans votre message**, par exemple : `Ventes : 120, Marketing : 80, Développement : 150`.",
      ].join("\n"),
      generationStatus: "complete",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Graphique demandé sans aucune donnée disponible." },
    };
  }

  try {
    await onEvent({ type: "status", phase: "execution", label: "Construction du graphique…" });
    // Conclusions réelles : analyse du modèle sur les données (repli déterministe).
    let conclusion = `Total : ${data.values.reduce((a, b) => a + b, 0).toLocaleString("fr-FR")} · Maximum : ${data.labels[data.values.indexOf(Math.max(...data.values))]} (${Math.max(...data.values).toLocaleString("fr-FR")}) · Minimum : ${data.labels[data.values.indexOf(Math.min(...data.values))]} (${Math.min(...data.values).toLocaleString("fr-FR")}) sur ${data.labels.length} catégorie(s).`;
    try {
      const analysis = await withTimeout(
        runAI({
          userId: ctx.userId,
          feature: "conversation-turn",
          task: "chat",
          system: "Tu es analyste de données. À partir du tableau fourni, rédige 2 à 4 phrases factuelles en français : tendance générale, valeurs remarquables (max/min), anomalies éventuelles. Aucune donnée non présente dans le tableau.",
          prompt: `Graphique ${chartIntent.chartType === "pie" ? "de répartition" : chartIntent.chartType === "line" ? "d'évolution" : "comparatif"}.\nDonnées : ${data.labels.map((l, i) => `${l}=${data.values[i]}`).join(", ")}`,
        }),
        20_000,
        "analyse des données",
      );
      if (analysis?.text && analysis.text.trim().length > 20) conclusion = analysis.text.trim();
    } catch {
      // Repli : statistiques déterministes ci-dessus, jamais de silence.
    }

    const html = buildChartHtml({
      title: chartIntent.title,
      chartType: chartIntent.chartType,
      labels: data.labels,
      values: data.values,
      source: data.source,
      conclusion,
    });
    const artifact = await createArtifact({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      type: "code",
      title: chartIntent.title,
      language: "html",
      filename: `graphique-${chartIntent.chartType}.html`,
      content: html,
      note: `Graphique interactif — export PNG/JPG intégré (${data.source})`,
    });
    await onEvent({ type: "artifact_created", artifact });

    const content = appendPreviewLinks(
      [
        `**${chartIntent.title}** — ${data.labels.length} catégorie(s) depuis ${data.source}.`,
        `Analyse : ${conclusion}`,
        "Dans l'aperçu, les boutons **Télécharger PNG / JPG** exportent le graphique en image ; demandez « exporte ces données en xlsx » pour un fichier Excel.",
      ].join("\n\n"),
      [artifact],
    );
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content,
      generationStatus: "complete",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [artifact],
      approvals: [],
      intent: { mode: "chat", understanding: "Analyse de données réelle (graphique + conclusions)." },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "La construction du graphique a échoué.";
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: `Je n'ai pas réussi à construire le graphique (${message}). Vos données sont intactes : réessayez en renvoyant votre message.`,
      generationStatus: "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Analyse de données (échec de construction)." },
    };
  }
}

/* ------------------------------------------------------------------ */
/* Tour « fourniture d'API » — création réelle du connecteur           */
/* ------------------------------------------------------------------ */

interface ApiProvisioningTurnContext extends TurnBase {
  provisioning: NonNullable<ReturnType<typeof detectApiProvisioning>>;
}

async function runApiProvisioningTurn(ctx: ApiProvisioningTurnContext): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  await onEvent({ type: "status", phase: "execution", label: "Enregistrement de votre API…" });

  let record: CustomApiRecord | null = null;
  let failure: string | undefined;
  try {
    record = await createCustomApi({
      userId: ctx.userId,
      name: ctx.provisioning.name,
      baseUrl: ctx.provisioning.baseUrl,
      description: ctx.provisioning.description,
      authType: ctx.provisioning.authType,
      authHeader: ctx.provisioning.authHeader,
      authValue: ctx.provisioning.authValue,
      queryKey: ctx.provisioning.queryKey,
      enabled: true,
      source: "chat",
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : "Création du connecteur impossible.";
  }

  const authLabel =
    ctx.provisioning.authType === "bearer"
      ? "Bearer (clé détectée)"
      : ctx.provisioning.authType === "header"
        ? `en-tête ${ctx.provisioning.authHeader ?? "Authorization"} (clé détectée)`
        : ctx.provisioning.authType === "query"
          ? "paramètre d'URL (clé détectée)"
          : "aucune (API publique)";

  const content = failure
    ? `Je n'ai pas pu enregistrer votre API : ${failure}`
    : [
        `Connecteur créé et activé : « ${record!.name} »`,
        `- URL de base : ${record!.baseUrl}`,
        `- Authentification : ${authLabel}`,
        "",
        "Je peux maintenant appeler cette API pour de vrai — par exemple :",
        `« Utilise l'API ${record!.name} pour … ».`,
        "Les lectures (GET) s'exécutent directement ; toute modification de données (POST/PUT/PATCH/DELETE) attendra votre validation. Vous pouvez gérer ou désactiver ce connecteur depuis Intégrations.",
      ].join("\n");

  const assistantMessage = await appendMessage({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    role: "assistant",
    content,
    generationStatus: "complete",
  });
  await onEvent({ type: "message_complete", message: assistantMessage });

  return {
    conversationId: ctx.conversationId,
    userMessage: ctx.userMessage,
    assistantMessage,
    artifacts: [],
    approvals: [],
    intent: { mode: "chat", understanding: "Fourniture d'une API personnelle (connecteur créé)." },
  };
}

/* ------------------------------------------------------------------ */
/* Tours « sous-services sous autorité de l'agent » — tâches planifiées */
/* et workflows : créés/pilotés RÉELLEMENT depuis le langage naturel.   */
/* ------------------------------------------------------------------ */

const TZ_FALLBACK = "UTC";

interface ServiceTurnContext extends TurnBase {
  timezone?: string;
}

/** Exécute un outil via l'exécuteur standard (politique, audit, quotas). */
async function executerOutilService(
  ctx: TurnBase,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
  try {
    const result = await executeTool({
      userId: ctx.userId,
      executionId: `conv_${ctx.conversationId}`,
      projectId: ctx.projectId,
      toolName,
      input,
      policy: CONVERSATION_EXECUTION_POLICY,
    });
    if (!result.success) {
      return { ok: false, error: result.error ?? "Exécution impossible." };
    }
    return { ok: true, output: result.output };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Exécution impossible." };
  }
}

function labelJoursFr(days: number[]): string {
  const tri = [...new Set(days)].sort((a, b) => a - b);
  if (tri.length === 7) return "tous les jours";
  if (tri.join(",") === "1,2,3,4,5") return "du lundi au vendredi";
  if (tri.join(",") === "0,6") return "le week-end";
  const noms = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  return tri.map((d) => noms[d] ?? String(d)).join(", ");
}

async function runScheduleIntentTurn(
  ctx: ServiceTurnContext,
  intent: ScheduleIntent,
): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  await onEvent({ type: "status", phase: "execution", label: "Mise en place de votre tâche planifiée…" });

  const resultat = await executerOutilService(ctx, "schedule.create", {
    name: intent.name,
    objective: intent.objective,
    daysOfWeek: intent.daysOfWeek,
    startTime: intent.startTime,
    endTime: intent.endTime,
    ...(intent.intervalMinutes !== undefined ? { intervalMinutes: intent.intervalMinutes } : {}),
    timezone: ctx.timezone?.trim() || TZ_FALLBACK,
  });

  const tz = ctx.timezone?.trim() || TZ_FALLBACK;
  const content = resultat.ok
    ? (() => {
        const output = resultat.output as {
          schedule?: { id: string; name: string };
          agent?: { name: string };
          recurrence?: string;
        };
        const schedule = output.schedule;
        const recurrence = output.recurrence ?? labelJoursFr(intent.daysOfWeek);
        return [
          `Tâche planifiée créée : « ${schedule?.name ?? intent.name} »`,
          `- Récurrence : ${recurrence}${intent.startTime ? ` (fenêtre ${intent.startTime} → ${intent.endTime})` : ""}${intent.intervalMinutes ? `, rappel toutes les ${intent.intervalMinutes} minutes` : ""}`,
          `- Fuseau : ${tz}`,
          `- Agent d'exécution : ${output.agent?.name ?? "résolu automatiquement"}`,
          `- Objectif : ${intent.objective.slice(0, 200)}`,
          "",
          "L'agent s'exécutera automatiquement selon cette récurrence (moteur de planification réel). Pour ajuster : « change l'heure de ma tâche planifiée… », « désactive ma tâche… » ou « supprime la tâche planifiée… ».",
        ].join("\n");
      })()
    : `Je n'ai pas pu créer la tâche planifiée : ${resultat.error}`;

  const assistantMessage = await appendMessage({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    role: "assistant",
    content,
    generationStatus: resultat.ok ? "complete" : "failed",
  });
  await onEvent({ type: "message_complete", message: assistantMessage });
  return {
    conversationId: ctx.conversationId,
    userMessage: ctx.userMessage,
    assistantMessage,
    artifacts: [],
    approvals: [],
    intent: { mode: "chat", understanding: "Création réelle d'une tâche planifiée (langage naturel)." },
  };
}

async function runWorkflowIntentTurn(
  ctx: ServiceTurnContext,
  intent: WorkflowIntent,
): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  await onEvent({ type: "status", phase: "execution", label: "Construction de votre workflow…" });

  const resultat = await executerOutilService(ctx, "workflow.create", {
    name: intent.name,
    objective: intent.objective,
    steps: intent.steps,
    ...(intent.runNow ? { runNow: true } : {}),
  });

  const content = resultat.ok
    ? (() => {
        const output = resultat.output as {
          id: string;
          name: string;
          nodeCount: number;
          steps?: string[];
          run?: { runId: string; status: string; result?: unknown; error?: string };
        };
        const lignes = [
          `Workflow créé : « ${output.name} » (${output.nodeCount} nœuds, exécutable)`,
          ...intent.steps.map((step, index) => `- Étape ${index + 1} : ${step.name}`),
          "",
          "Il est enregistré dans votre espace : lancez-le depuis la conversation (« exécute le workflow … »), ou modifiez-le dans le Studio.",
        ];
        if (output.run) {
          lignes.push("", `Exécution immédiate : statut ${output.run.status}${output.run.result !== undefined ? ` — résultat : ${JSON.stringify(output.run.result).slice(0, 600)}` : ""}${output.run.error ? ` — erreur : ${output.run.error.slice(0, 300)}` : ""}`);
        }
        return lignes.join("\n");
      })()
    : `Je n'ai pas pu créer le workflow : ${resultat.error}`;

  const assistantMessage = await appendMessage({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    role: "assistant",
    content,
    generationStatus: resultat.ok ? "complete" : "failed",
  });
  await onEvent({ type: "message_complete", message: assistantMessage });
  return {
    conversationId: ctx.conversationId,
    userMessage: ctx.userMessage,
    assistantMessage,
    artifacts: [],
    approvals: [],
    intent: { mode: "chat", understanding: "Création réelle d'un workflow (langage naturel)." },
  };
}

async function runServiceControlTurn(
  ctx: ServiceTurnContext,
  controle: ServiceControlIntent,
): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  const tz = ctx.timezone?.trim() || TZ_FALLBACK;

  // Suppression : action définitive → plan avec validation humaine (HITL).
  if (controle.action === "delete") {
    const toolName = controle.target === "schedule" ? "schedule.delete" : "workflow.delete";
    const intent: TurnIntent = {
      mode: "plan",
      understanding:
        controle.target === "schedule"
          ? "Suppression d'une tâche planifiée (validation humaine requise)."
          : "Suppression d'un workflow (validation humaine requise).",
      objective: `Supprimer ${controle.name ? `« ${controle.name} »` : "l'élément ciblé"}`,
      steps: [
        {
          title: `Supprimer ${controle.target === "schedule" ? "la tâche planifiée" : "le workflow"}${controle.name ? ` « ${controle.name} »` : ""}`,
          detail: "Action définitive — arrête l'automatisation récurrente correspondante.",
          toolName,
          toolInput: controle.name ? { name: controle.name } : {},
          sensitive: true,
        },
      ],
    };
    return runPlanTurn({ ...ctx, intent });
  }

  // Liste des tâches planifiées.
  if (controle.target === "schedule" && controle.action === "list") {
    await onEvent({ type: "status", phase: "execution", label: "Consultation de vos tâches planifiées…" });
    const resultat = await executerOutilService(ctx, "schedule.list", {});
    const content = !resultat.ok
      ? `Impossible de consulter vos tâches planifiées : ${resultat.error}`
      : (() => {
          const output = resultat.output as {
            count: number;
            schedules: Array<{
              name: string; enabled: boolean; daysOfWeek: number[] | null;
              startTime: string | null; endTime: string | null; intervalMinutes: number;
              lastExecutionStatus: string | null;
            }>;
          };
          if (output.count === 0) {
            return "Vous n'avez aucune tâche planifiée pour le moment. Dites-moi par exemple : « chaque lundi à 9h, prépare-moi un rapport des actualités IA » et je la mets en place.";
          }
          return [
            `Vos tâches planifiées (${output.count}) :`,
            ...output.schedules.map((s) => {
              const recurrence = s.daysOfWeek?.length ? labelJoursFr(s.daysOfWeek) : "tous les jours";
              const fenetre = s.startTime ? ` (${s.startTime} → ${s.endTime ?? "23:59"}${s.intervalMinutes ? `, toutes les ${s.intervalMinutes} min` : ""})` : "";
              const dernier = s.lastExecutionStatus ? ` — dernière exécution : ${s.lastExecutionStatus}` : "";
              return `- ${s.enabled ? "●" : "○"} « ${s.name} » — ${recurrence}${fenetre}${dernier}`;
            }),
          ].join("\n");
        })();
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId, userId: ctx.userId, role: "assistant", content,
      generationStatus: resultat.ok ? "complete" : "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId, userMessage: ctx.userMessage, assistantMessage,
      artifacts: [], approvals: [],
      intent: { mode: "chat", understanding: "Liste des tâches planifiées." },
    };
  }

  // Liste des workflows.
  if (controle.target === "workflow" && controle.action === "list") {
    await onEvent({ type: "status", phase: "execution", label: "Consultation de vos workflows…" });
    const resultat = await executerOutilService(ctx, "workflow.list", {});
    const content = !resultat.ok
      ? `Impossible de consulter vos workflows : ${resultat.error}`
      : (() => {
          const output = resultat.output as { count: number; workflows: Array<{ name: string; nodeCount: number }> };
          if (output.count === 0) {
            return "Vous n'avez aucun workflow pour le moment. Dites-moi par exemple : « crée un workflow : étape 1 : recherche les tendances, étape 2 : rédige un résumé » et je le construis.";
          }
          return [
            `Vos workflows (${output.count}) :`,
            ...output.workflows.map((w) => `- « ${w.name} » (${w.nodeCount} nœuds)`),
            "",
            "Pour en exécuter un : « exécute le workflow … ».",
          ].join("\n");
        })();
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId, userId: ctx.userId, role: "assistant", content,
      generationStatus: resultat.ok ? "complete" : "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId, userMessage: ctx.userMessage, assistantMessage,
      artifacts: [], approvals: [],
      intent: { mode: "chat", understanding: "Liste des workflows." },
    };
  }

  // Activation / désactivation d'une tâche planifiée.
  if (controle.target === "schedule" && (controle.action === "enable" || controle.action === "disable")) {
    await onEvent({
      type: "status", phase: "execution",
      label: controle.action === "enable" ? "Activation de la tâche planifiée…" : "Désactivation de la tâche planifiée…",
    });
    const input: Record<string, unknown> = { enable: controle.action === "enable" };
    if (controle.name) input.name = controle.name;
    const resultat = await executerOutilService(ctx, "schedule.update", input);
    const content = resultat.ok
      ? (() => {
          const output = resultat.output as { schedule?: { name: string; enabled: boolean } };
          return `Tâche planifiée « ${output.schedule?.name ?? controle.name ?? ""} » ${output.schedule?.enabled ? "réactivée" : "désactivée"} — ${output.schedule?.enabled ? "elle reprendra sa récurrence" : "elle ne s'exécutera plus"} (fuseau ${tz}).`;
        })()
      : `Je n'ai pas pu modifier la tâche planifiée : ${resultat.error}`;
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId, userId: ctx.userId, role: "assistant", content,
      generationStatus: resultat.ok ? "complete" : "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId, userMessage: ctx.userMessage, assistantMessage,
      artifacts: [], approvals: [],
      intent: { mode: "chat", understanding: "Pilotage d'une tâche planifiée." },
    };
  }

  // Exécution d'un workflow existant.
  if (controle.target === "workflow" && controle.action === "run") {
    await onEvent({ type: "status", phase: "execution", label: "Exécution du workflow…" });
    const input: Record<string, unknown> = {};
    if (controle.name) input.name = controle.name;
    const resultat = await executerOutilService(ctx, "workflow.run", input);
    const content = resultat.ok
      ? (() => {
          const output = resultat.output as { runId: string; status: string; workflow?: { name: string }; result?: unknown; error?: string };
          return [
            `Workflow « ${output.workflow?.name ?? controle.name ?? ""} » exécuté — statut : ${output.status}.`,
            output.result !== undefined ? `Résultat : ${JSON.stringify(output.result).slice(0, 1200)}` : "",
            output.error ? `Erreur : ${output.error.slice(0, 500)}` : "",
          ].filter(Boolean).join("\n");
        })()
      : `Je n'ai pas pu exécuter le workflow : ${resultat.error}`;
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId, userId: ctx.userId, role: "assistant", content,
      generationStatus: resultat.ok ? "complete" : "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId, userMessage: ctx.userMessage, assistantMessage,
      artifacts: [], approvals: [],
      intent: { mode: "chat", understanding: "Exécution réelle d'un workflow." },
    };
  }

  // Repli : le cas n'est pas géré en conversation → tour normal.
  return runChatTurn({ ...ctx, intent: { mode: "chat", understanding: "Demande générique." } });
}

/* ------------------------------------------------------------------ */
/* Tour « plan » — timeline, outils, approbations, artefacts           */
/* ------------------------------------------------------------------ */

const TOOL_OUTPUT_ARTIFACTS: ReadonlySet<string> = new Set(["artifact.create", "file.create", "zip.create", "voice.speak"]);

/* ------------------------------------------------------------------ */
/* Completion du contenu des livrables (artifact.create)               */
/* ------------------------------------------------------------------ */

const DocumentBlocksSchema = z.object({
  title: z.string().min(1).max(300),
  format: z.enum(["pdf", "docx", "xlsx", "pptx", "csv", "md", "txt", "json", "html"]),
  blocks: z.array(
    z.object({
      type: z.enum(["title", "heading", "paragraph", "list", "table", "code", "quote", "pageBreak"]),
      text: z.string().max(200_000).optional(),
      level: z.number().int().min(1).max(6).optional(),
      ordered: z.boolean().optional(),
      items: z.array(z.string().max(20_000)).max(2_000).optional(),
      columns: z.array(z.string().max(10_000)).max(1_000).optional(),
      rows: z.array(z.array(z.string().max(10_000)).max(1_000)).max(2_000).optional(),
      language: z.string().max(100).optional(),
    }),
  ).min(1).max(2_000),
});

/**
 * Complète l'entrée d'artifact.create quand le plan ne contient pas les blocs
 * du document : l'IA d'intention ne peut pas pré-rédiger tout un document dans
 * son budget de tokens. Un appel de rédaction dédié produit le contenu
 * intégral, puis l'outil génère le fichier réel (pdf/docx/xlsx/pptx).
 * Retourne null si la rédaction est impossible — l'étape est alors ignorée
 * avec une raison claire (jamais de fichier vide ou corrompu).
 */
async function ensureArtifactInput(
  ctx: TurnContext,
  planned: { title: string; detail?: string },
  toolInput: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const hasTitle = typeof toolInput.title === "string" && toolInput.title.trim().length > 0;
  const blocks = Array.isArray(toolInput.blocks) ? (toolInput.blocks as unknown[]) : [];
  if (hasTitle && blocks.length > 0) return toolInput;

  /**
   * Rédaction via le chemin STREAMING (le même qui produit les applications
   * web en ~35 s) : les fournisseurs « chat » livrent leurs tokens au fil de
   * l'eau et complètent bien avant les appels non-streamés, qui dépassaient
   * le budget sur un JSON de plusieurs milliers de tokens. Le texte collecté
   * est ensuite parsé en JSON (extractJsonObject) et validé par le schéma.
   */
  const draft = async (maxTokens: number, budgetMs: number) => {
    const request = {
      task: "chat" as const,
      messages: [
        {
          role: "system" as const,
          content:
            "Tu rédiges le contenu d'un document professionnel pour l'utilisateur de Gen3ia. " +
            "Tu produis UNIQUEMENT un objet JSON valide (sans texte autour, sans bloc de code) : " +
            '{ "title": "<titre court>", "format": "<format>", "blocks": [...] }. ' +
            "Blocs disponibles : title (une seule fois, en premier), heading (sections), paragraph (texte rédigé), " +
            "list (puces {items}), table ({columns, rows}) si des données le justifient, quote, pageBreak. " +
            "Le contenu doit être rédigé intégralement et de façon professionnelle : jamais de placeholder, " +
            "jamais de « … », jamais de section vide.",
        },
        {
          role: "user" as const,
          content:
            `Demande de l'utilisateur : ${ctx.message.slice(0, 2000)}\n` +
            `Objectif du plan : ${ctx.intent.objective ?? "(celui de la demande)"}\n` +
            `Étape : ${planned.title}${planned.detail ? ` — ${planned.detail}` : ""}\n` +
            `Format attendu : ${typeof toolInput.format === "string" ? toolInput.format : "pdf"}\n` +
            `Titre proposé : ${hasTitle ? String(toolInput.title) : "(à déduire de la demande)"}` +
            `${ctx.priorHistory.length > 0 ? `\n\nContexte récent de la conversation :\n${historyForModel(ctx.priorHistory, 4).map((m) => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content.slice(0, 400)}`).join("\n")}` : ""}`,
        },
      ],
      provider: ctx.provider as never,
      model: ctx.model,
      preferFree: preferFreeForVisibleAnswers(),
      maxTokens,
      metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
    };
    const response = await withTimeout(
      generateStream(request, { onDelta: () => undefined }).catch(() =>
        generate(request),
      ),
      budgetMs,
      "rédaction du livrable",
    );
    return DocumentBlocksSchema.parse(extractJsonObject(response.text));
  };

  try {
    // Première tentative : budget généreux, sortie complète.
    const generated = await draft(6000, 60_000);
    return {
      ...toolInput,
      title: hasTitle ? String(toolInput.title) : generated.title,
      format: typeof toolInput.format === "string" ? toolInput.format : generated.format,
      blocks: generated.blocks,
    };
  } catch (error) {
    console.error(JSON.stringify({
      event: "artifact.redaction_fallback",
      reason: error instanceof Error ? error.message : String(error),
      format: toolInput.format ?? "pdf",
    }));
    // Seconde tentative, plus resserrée : un fournisseur lent ne doit pas
    // priver l'utilisateur de son livrable (pptx/pdf/docx demandé).
    try {
      const generated = await draft(3500, 45_000);
      return {
        ...toolInput,
        title: hasTitle ? String(toolInput.title) : generated.title,
        format: typeof toolInput.format === "string" ? toolInput.format : generated.format,
        blocks: generated.blocks,
      };
    } catch {
      // Rédaction indisponible (timeout, fournisseur saturé) : l'étape sera
      // ignorée proprement avec un message clair pour l'utilisateur.
      return null;
    }
  }
}

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
  // Timeline persistée APRÈS CHAQUE ÉTAPE (et pas seulement à la fin du
  // plan) : si la fonction est tuée par le budget plateforme en cours de
  // route, les étapes déjà réussies restent visibles dans le fil et le run
  // n'est plus un fantôme « running » sans contenu.
  const persistSteps = async () => {
    try {
      await updateRunSteps(ctx.userId, run.id, steps);
    } catch {
      // Timeline best-effort : un incident Firestore ne doit jamais faire
      // échouer une étape dont le travail a réussi.
    }
  };
  await onEvent({ type: "run_created", run: { ...run, status: "running", steps } });
  await onEvent({ type: "status", phase: "execution", label: "Exécution du plan en cours…" });

  let executedSomething = false;
  let anyFailure = false;
  /** Image générée pendant ce tour (affichée sur le message final). */
  let turnImageUrl: string | undefined;
  /** Task 143 — connecteurs Composio requis mais NON connectés par
   * l'utilisateur : collectés pendant l'exécution (erreur typée
   * CONNECTOR_MISSING) pour attacher la carte « Connecter <App> » au
   * message final — l'agent propose alors le bouton de connexion OAuth. */
  const missingConnectors: string[] = [];

  for (const planned of plannedSteps) {
    // Compétence image : l'étape image.generate est interceptée AVANT le
    // catalogue d'outils — la génération réelle (Agnes AI 2K) produit une
    // image attachée au message final et rangée dans les artefacts.
    if (planned.toolName === "image.generate") {
      const step = makeStep({
        phase: "execution",
        title: planned.title,
        detail: planned.detail,
        toolName: "image.generate",
        toolInput: planned.toolInput,
        status: "in_progress",
      });
      steps.push(step);
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      const startedAt = new Date().toISOString();
      try {
        const image = await produceConversationImage(
          ctx,
          typeof planned.toolInput?.prompt === "string" ? planned.toolInput.prompt : undefined,
          async ({ label, stage, percent }) => {
            await onEvent({ type: "status", phase: "image", label, stage, percent });
          },
        );
        step.status = "done";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = `Image générée avec ${image.model}.`;
        executedSomething = true;
        turnImageUrl = image.inlineDataUrl ?? image.imageUrl;
        const artifact = await createArtifact({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          projectId: ctx.projectId,
          runId: run.id,
          type: "image",
          title: (typeof planned.toolInput?.prompt === "string" && planned.toolInput.prompt.trim() ? planned.toolInput.prompt.trim() : ctx.message).slice(0, 80),
          url: image.inlineDataUrl ?? image.imageUrl,
          storagePath: image.storagePath,
          note: `Généré par le moteur neuronal Gen3 (${image.model})`,
        });
        artifacts.push(artifact);
        step.artifactId = artifact.id;
        await onEvent({ type: "artifact_created", artifact });
      } catch (error) {
        step.status = "failed";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = error instanceof Error ? error.message : "La génération d'image a échoué.";
        anyFailure = true;
      }
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      continue;
    }

    // Compétence vidéo : l'étape video.create est interceptée AVANT le
    // catalogue d'outils — la production RÉELLE (file autopilotée) démarre
    // immédiatement et l'artefact vidéo (progression temps réel) est rattaché
    // au run, comme pour l'image.
    if (planned.toolName === "video.create") {
      const step = makeStep({
        phase: "execution",
        title: planned.title,
        detail: planned.detail,
        toolName: "video.create",
        toolInput: planned.toolInput,
        status: "in_progress",
      });
      steps.push(step);
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      const startedAt = new Date().toISOString();
      try {
        const { createVideoProductionJob } = await import("@/lib/video/production-queue");
        // BRIEF TROP COURT (fix capture 13:02) : DirectorBriefSchema exige
        // 10 caractères minimum — un prompt du planificateur trop court est
        // ENRICHI du message utilisateur (jamais d'échec de validation pour
        // une valeur que la plateforme peut compléter).
        const promptPlan = typeof planned.toolInput?.prompt === "string" ? planned.toolInput.prompt.trim() : "";
        const promptInput =
          promptPlan.length >= 10
            ? promptPlan
            : [promptPlan, ctx.message.trim()].filter((part) => part.length >= 10)[0] ?? `Production vidéo demandée : ${promptPlan || ctx.message.trim()}`;
        // TITRE TROP COURT : VideoProjectCreateSchema exige 3 caractères
        // minimum — repli sur le titre déduit de la demande (extrait vidéo).
        const titlePlan = typeof planned.toolInput?.title === "string" ? planned.toolInput.title.trim() : "";
        const titleInput = titlePlan.length >= 3 ? titlePlan.slice(0, 120) : extractVideoTitle(promptInput);
        const aspectInput = planned.toolInput && typeof planned.toolInput === "object" && "aspectRatio" in planned.toolInput ? String((planned.toolInput as Record<string, unknown>).aspectRatio) : undefined;
        // Contrat aspectRatio (audit 103-f) : source unique — le constant
        // partagé VIDEO_ASPECT_RATIOS du tool video.create (Task 106-a :
        // aligné sur le pipeline, 5 valeurs) valide l'entrée du planificateur.
        const aspectValide = VIDEO_ASPECT_RATIOS.find((ratio) => ratio === aspectInput);
        // Task 106-a — RELAIS COMPLET des paramètres : duration/résolution/
        // langue/style/audience/plateforme/musique/formats dérivés passés
        // tels quels au filtre validé (clés inconnues écartées), puis
        // DÉTECTION complémentaire déterministe depuis la demande (le LLM
        // peut avoir oublié durée/format — l'extraction rattrape).
        const relayed = sanitizeProductionOptions(planned.toolInput);
        if (aspectValide) relayed.aspectRatio = aspectValide;
        const detected = extractVideoParams(promptInput);
        const options = { ...detected, ...relayed };
        // DURÉE HORS-BORNES (fix capture 13:02) : le planificateur transmet
        // FIDÈLEMENT la demande (« une vidéo de 5s » → targetDurationSec: 5)
        // mais le pipeline impose 10..3600 s — on BORNE au lieu d'échouer
        // (la validation écrasait la valeur détectée déjà clampée et faisait
        // échouer TOUTE demande de courte durée : « Le lancement de la
        // production vidéo a échoué »).
        const durationRaw = Number(options.targetDurationSec);
        if (Number.isFinite(durationRaw) && durationRaw > 0) {
          options.targetDurationSec = Math.min(3600, Math.max(10, Math.round(durationRaw)));
        } else {
          delete options.targetDurationSec;
        }
        const job = await createVideoProductionJob({
          userId: ctx.userId,
          prompt: promptInput.slice(0, 4000),
          title: titleInput,
          // Task 107-a — conversation d'origine portée par le job (livraison
          // chat à la complétion, même contrat que le tour vidéo).
          conversationId: ctx.conversationId,
          ...(Object.keys(options).length > 0 ? { options } : {}),
        });
        step.status = "done";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = `Production vidéo lancée (projet ${job.projectId}) — progression en temps réel.`;
        executedSomething = true;
        const artifact = await createArtifact({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          projectId: ctx.projectId,
          runId: run.id,
          type: "video",
          title: promptInput.slice(0, 80),
          note: "Production vidéo autonome — progression en temps réel",
          videoProjectId: job.projectId,
          videoJobId: job.jobId,
        });
        artifacts.push(artifact);
        step.artifactId = artifact.id;
        await onEvent({ type: "artifact_created", artifact });
      } catch (error) {
        step.status = "failed";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = error instanceof Error && /n.est pas disponible/.test(error.message)
          ? "La production vidéo n'est pas disponible sur cette plateforme actuellement."
          : "Le lancement de la production vidéo a échoué.";
        anyFailure = true;
      }
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      continue;
    }

    // Task 106-a — SUIVI vidéo : l'étape video.status est interceptée AVANT
    // le catalogue (même pattern que video.create) — exécution RÉELLE de
    // l'outil, message d'état FR complet (stage, %, avertissements, URL).
    if (planned.toolName === "video.status") {
      const step = makeStep({
        phase: "tools",
        title: planned.title,
        detail: planned.detail,
        toolName: "video.status",
        toolInput: planned.toolInput,
        status: "in_progress",
      });
      steps.push(step);
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      const startedAt = new Date().toISOString();
      try {
        const { videoStatusTool } = await import("@/lib/tools/media/video-status");
        const input = planned.toolInput && typeof planned.toolInput === "object" ? planned.toolInput : {};
        const parsed = videoStatusTool.inputSchema.parse(input);
        const output = await videoStatusTool.execute(parsed, { userId: ctx.userId });
        step.status = output.found ? "done" : "failed";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = output.message;
        executedSomething = true;
      } catch (error) {
        step.status = "failed";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = error instanceof Error ? `Suivi vidéo impossible : ${error.message}` : "Suivi vidéo impossible.";
        anyFailure = true;
      }
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      continue;
    }

    // Task 106-a — RÉVISION/PILOTAGE vidéo : pause/reprise/annulation du
    // rendu, révisions conversationnelles (musique, rythme, voix…) et
    // formats dérivés — exécution RÉELLE, message FR actionnable.
    if (planned.toolName === "video.revise") {
      const step = makeStep({
        phase: "tools",
        title: planned.title,
        detail: planned.detail,
        toolName: "video.revise",
        toolInput: planned.toolInput,
        status: "in_progress",
      });
      steps.push(step);
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      const startedAt = new Date().toISOString();
      try {
        const { videoReviseTool } = await import("@/lib/tools/media/video-revise");
        const input = planned.toolInput && typeof planned.toolInput === "object" ? planned.toolInput : {};
        const parsed = videoReviseTool.inputSchema.parse(input);
        const output = await videoReviseTool.execute(parsed, { userId: ctx.userId });
        step.status = output.applied ? "done" : "failed";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = output.message;
        executedSomething = true;
      } catch (error) {
        step.status = "failed";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = error instanceof Error
          ? `Révision impossible : ${error.message.replace(/\s+/g, " ").slice(0, 300)}`
          : "Révision impossible.";
        anyFailure = true;
      }
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      continue;
    }

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
      await persistSteps();
      continue;
    }

    let toolName = planned.toolName ?? undefined;
    const risk = toolEntry?.risk ?? "low";
    // OUTILS INTERNES (directive 10-10) : la génération d'image/vidéo/audio,
    // les fichiers, mémoires et automatisations Gen3ia ne demandent JAMAIS
    // d'approbation — même si le planificateur ou un risque résiduel les
    // marque sensibles. La validation ne concerne que les apps externes non
    // connectées et les actions manipulant des secrets utilisateur.
    const internalTool = toolName ? INTERNAL_ACTION_TOOLS.has(toolName) : false;
    let sensitive = internalTool
      ? false
      : planned.sensitive === true || (toolName ? stepRequiresApproval(risk) : false);

    // APPROBATION CONDITIONNELLE (demande utilisateur) : quand l'app externe
    // ciblée est DÉJÀ CONNECTÉE par l'utilisateur (statut actif), l'agent
    // agit directement — aucune carte de validation. L'approbation ne reste
    // requise que si l'app est non connectée (ou inconnue) et pour le
    // plancher de sécurité invariant (risque critical / ads.publish /
    // file.delete / phone.call).
    let connectedBypass = false;
    if (toolName && sensitive && risk !== "critical") {
      try {
        connectedBypass = await isExternalAppConnected(
          ctx.userId,
          toolName,
          (planned.toolInput ?? {}) as Record<string, unknown>,
        );
      } catch {
        connectedBypass = false;
      }
      if (connectedBypass) {
        sensitive = false;
        console.log(JSON.stringify({
          event: "approval.bypassed_connected_app",
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          toolName,
          risk,
        }));
      }
    }

    // Mode « Autoriser automatiquement » : les actions sensibles NON critiques
    // s'exécutent directement (piste d'audit), le plancher de sécurité reste
    // invariant (ads.publish / file.delete / risque critical).
    const autoAllowed = toolName ? isAutoApprovable(ctx.authorizationMode, toolName, risk) : false;
    if (autoAllowed) {
      console.log(JSON.stringify({
        event: "approval.auto_approved",
        reason: AUTO_APPROVAL_AUDIT_REASON,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        toolName,
        risk,
      }));
    }

    if (toolName && sensitive && !autoAllowed) {
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
      await persistSteps();
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
      detail: autoAllowed
        ? `${planned.detail ?? toolEntry?.description ?? ""}\n(${AUTO_APPROVAL_AUDIT_REASON})`
        : planned.detail,
      toolName,
      toolInput: planned.toolInput,
      status: "in_progress",
    });
    steps.push(step);
    await onEvent({ type: "step_update", runId: run.id, step });
    await persistSteps();

    if (toolName) {
      const startedAt = new Date().toISOString();
      let toolInput = (planned.toolInput ?? {}) as Record<string, unknown>;
      // GARDE ANTI-ERREUR : une écriture (méthode/corps énoncés) ne doit
      // JAMAIS passer par web.api (lecture seule) — réécrite en web.api.write.
      if (toolName === "web.api" && catalogByName.get("web.api.write")) {
        const writeIntent = detectApiWriteIntent(ctx.message);
        const hasWriteShape = typeof toolInput.method === "string" || toolInput.body !== undefined;
        if (hasWriteShape || writeIntent) {
          toolName = "web.api.write";
          toolInput = {
            ...toolInput,
            method: (toolInput.method as string) ?? writeIntent?.method ?? "POST",
            ...(toolInput.body !== undefined ? {} : writeIntent?.body ? { body: writeIntent.body } : {}),
          };
          console.log(JSON.stringify({ event: "tool_route_corrected", from: "web.api", to: "web.api.write", conversationId: ctx.conversationId }));
        }
      }
      if (toolName === "artifact.create") {
        // Le contenu du livrable est finalisé juste avant la génération du
        // fichier : jamais de document vide ni d'échec zod opaque.
        const completed = await ensureArtifactInput(ctx, planned, toolInput);
        if (!completed) {
          step.status = "skipped";
          step.detail = `${step.detail ? `${step.detail}\n` : ""}Contenu du livrable indisponible (rédaction impossible pour le moment) — aucun fichier créé.`.trim();
          step.finishedAt = new Date().toISOString();
          await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
          continue;
        }
        toolInput = completed;
      }
      const result = await executeTool({
        userId: ctx.userId,
        executionId: run.id,
        projectId: ctx.projectId,
        toolName,
        input: toolInput,
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
        // Task 143 — connecteur manquant : le toolkit est proposé à la
        // connexion (bouton OAuth sous la réponse), pas seulement signalé.
        const missing = parseConnectorMissing(result.error);
        if (missing && !missingConnectors.includes(missing.toolkit)) {
          missingConnectors.push(missing.toolkit);
        }
      }
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
    } else {
      // Étape de rédaction : traitée par le modèle à la synthèse finale.
      step.status = "done";
      step.finishedAt = new Date().toISOString();
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
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
  // AUTO-AMÉLIORATION : issue réelle de l'exécution enregistrée (leçons des
  // échecs + progression de complexité) — le système évolue à chaque run.
  void recordRunOutcome({
    userId: ctx.userId,
    objective: run.objective || ctx.message,
    status: runStatus,
    complexityScore: ctx.complexityScore,
    failedSteps: steps
      .filter((s) => s.status === "failed")
      .slice(0, 3)
      .map((s) => ({ title: s.title, detail: s.detail })),
  }).catch(() => undefined);

  const assistantMessage = await appendMessage({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    role: "assistant",
    // Contrat ARTEFACTS : tout artefact « app » produit par le plan reçoit
    // son lien web d'aperçu dans le message final.
    content: appendPreviewLinks(summary, artifacts),
    runId: run.id,
    generationStatus: "complete",
    ...(turnImageUrl ? { imageUrl: turnImageUrl } : {}),
    // Task 143 — connecteurs manquants détectés pendant l'exécution : la
    // carte « Connecter <App> » (bouton OAuth) est rendue sous la réponse.
    ...(missingConnectors.length > 0 ? { missingConnectors: uniqueToolkits(missingConnectors) } : {}),
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
            "les actions sensibles qui attendent sa validation. Pas de markdown de titre (#). " +
            "RÈGLE ABSOLUE D'HONNÊTETÉ : une étape marquée [failed] n'est PAS livrée — ne dis JAMAIS " +
            "qu'un résultat est livré/terminé/produit si l'étape correspondante est en échec ; cite " +
            "explicitement chaque échec et ce qui reste à faire. Les étapes [done] seules peuvent " +
            "être annoncées comme réalisées, avec leur sortie réelle.",
        },
        {
          role: "user" as const,
          content:
            `Demande : ${ctx.message.slice(0, 1000)}\nObjectif du plan : ${run.objective}\n` +
            `Étapes :\n${steps.map((s) => `- [${s.status}] ${s.title}${s.output ? ` : ${s.output.slice(0, 400)}` : ""}`).join("\n")}\n` +
            `Artefacts : ${artifacts.map((a) => `${a.title} (${a.type})`).join(", ") || "aucun"}\n` +
            `Validations en attente : ${approvals.map((a) => `${a.title} — impact : ${a.impact}`).join(" ; ") || "aucune"}` +
            (ctx.filesContext ? `\n\nContenu réel des fichiers importés :${ctx.filesContext}` : ""),
        },
      ],
      preferFree: preferFreeForVisibleAnswers(),
      maxTokens: 1200,
      metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
    };
    if (onDelta) {
      // Synthèse en flux : les fragments rejoignent le fil en direct.
      const response = await withTimeout(
        generateStream(request, { onDelta }),
        SUMMARY_BUDGET_MS,
        "synthèse du plan",
      );
      return appendFailureAppendix(response.text || deterministic, steps);
    }
    const response = await withTimeout(generate(request), SUMMARY_BUDGET_MS, "synthèse du plan");
    return appendFailureAppendix(response.text || deterministic, steps);
  } catch {
    // Synthèse indisponible (ou flux interrompu) : le repli déterministe est
    // renvoyé d'un bloc — le client remplace le texte en cours par la version
    // finale au moment de message_complete.
    return appendFailureAppendix(deterministic, steps);
  }
}

/**
 * HONNÊTETÉ DE LIVRAISON (étape 3) : annexe DÉTERMINISTE ajoutée au texte
 * final dès qu'une étape est en échec — même si la synthèse LLM omet ou
 * minimise les échecs, l'utilisateur voit la liste exacte de ce qui n'est
 * PAS livré. Pure, testée sans LLM.
 */
export function planFailureAppendix(steps: RunStep[]): string | undefined {
  const failed = steps.filter((s) => s.status === "failed");
  if (failed.length === 0) return undefined;
  const lines = failed.slice(0, 5).map((s) => `- ${s.title}${s.output ? ` — ${s.output.slice(0, 200)}` : ""}`);
  return [
    "",
    "⚠️ Mission incomplète — les éléments suivants ne sont PAS livrés :",
    ...lines,
    failed.length > 5 ? `- … et ${failed.length - 5} autre(s)` : "",
    "Relancez ou demandez-moi de reprendre la mission pour compléter ces étapes.",
  ].filter(Boolean).join("\n");
}

function appendFailureAppendix(text: string, steps: RunStep[]): string {
  const appendix = planFailureAppendix(steps);
  return appendix ? `${text}${appendix}` : text;
}

/* ------------------------------------------------------------------ */
/* Artefact issu d'une sortie d'outil                                  */
/* ------------------------------------------------------------------ */

/** Détecte le type d'artefact adapté à la sortie d'un outil de création. */
export function inferArtifactType(toolName: string, output: unknown): "code" | "document" | "table" | "image" | "report" | "file" | "audio" {
  const outputStr = typeof output === "string" ? output : JSON.stringify(output ?? {});
  if (/data:audio|audio\/|voice\.speak/i.test(outputStr) || toolName.includes("voice")) return "audio";
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
  // Voix générée (voice.speak) : l'audio arrive en data URI. Il est copié
  // dans le stockage permanent quand R2 est configuré, sinon conservé en
  // data URI (bornée) — l'utilisateur obtient un artefact AUDIO lisible et
  // téléchargeable au lieu d'un base64 tronqué dans la timeline.
  const audioDataUri = typeof outputRecord.audioDataUri === "string" && outputRecord.audioDataUri.startsWith("data:audio/")
    ? outputRecord.audioDataUri
    : undefined;
  // Task 113 — l'outil voice.speak a DÉJÀ archivé l'audio en permanence
  // (champ `url` = clé R2 users/<uid>/permanent/ai-audio/…) : on la RÉUTILISE
  // comme storagePath de l'artefact au lieu de re-uploader une deuxième
  // copie — moins d'I/O et surtout PLUS JAMAIS d'artefact audio sans clé
  // résolvable (l'ancien catch muet produisait un artefact dont l'`url`
  // brute n'était pas une URL : lecteur audio muet pour l'utilisateur).
  const toolPermanentKey =
    typeof outputRecord.url === "string" && outputRecord.url.startsWith(`users/${params.userId}/permanent/`)
      ? outputRecord.url
      : undefined;
  let audioStoragePath: string | undefined;
  let audioInlineContent: string | undefined;
  if (audioDataUri && !toolPermanentKey) {
    try {
      const [header, base64] = audioDataUri.split(",");
      const mime = header.slice(5).replace(/;base64$/, "") || "audio/mpeg";
      const buffer = Buffer.from(base64 ?? "", "base64");
      if (buffer.length > 0 && isR2Configured()) {
        const ext = mime.includes("wav") ? "wav" : mime.includes("ogg") ? "ogg" : "mp3";
        const key = `users/${params.userId}/permanent/ai-audio/${Date.now()}-${randomUUID()}.${ext}`;
        await uploadToR2(key, buffer, mime);
        audioStoragePath = key;
      } else if (buffer.length > 0 && audioDataUri.length <= 600_000) {
        audioInlineContent = audioDataUri;
      }
    } catch (audioError) {
      // Task 113 — incident JOURNALISÉ (plus de catch muet) : l'audio reste
      // livrable via le data URI inline si la taille le permet.
      console.warn(
        "[conversation] persistance R2 de l'audio voice.speak échouée — repli inline si possible :",
        audioError instanceof Error ? audioError.message : String(audioError),
      );
      if (audioDataUri.length <= 600_000) audioInlineContent = audioDataUri;
    }
  }
  // Les livrables de documents (artifact.create) exposent `storageKey` —
  // même contrat que path/key : le fichier reste téléchargeable depuis le
  // panneau des artefacts (service signé ou repli inline sans R2).
  const storagePath =
    typeof outputRecord.path === "string"
      ? outputRecord.path
      : typeof outputRecord.key === "string"
        ? outputRecord.key
        : typeof outputRecord.storageKey === "string"
          ? outputRecord.storageKey
          : undefined;
  if (!content && !url && !storagePath && !audioStoragePath && !toolPermanentKey && !audioInlineContent) return null;

  const inputTitle = typeof params.toolInput.title === "string" ? params.toolInput.title : undefined;
  const inputFilename = typeof params.toolInput.filename === "string" ? params.toolInput.filename : typeof params.toolInput.name === "string" ? params.toolInput.name : undefined;
  const isAudioArtifact = Boolean(audioStoragePath || toolPermanentKey || audioInlineContent);
  const type = isAudioArtifact
    ? "audio"
    : inferArtifactType(params.toolName, params.output ?? "");
  const note = isAudioArtifact
    ? "Audio généré par la voix IA"
    : `Produit par l'outil ${params.toolName}`;
  return createArtifact({
    userId: params.userId,
    conversationId: params.conversationId,
    projectId: params.projectId,
    runId: params.runId,
    type,
    title: (inputTitle || inputFilename || `Artefact — ${params.toolName}`).slice(0, 200),
    language: typeof params.toolInput.language === "string" ? params.toolInput.language : undefined,
    filename: inputFilename ?? (type === "audio" ? `voix-${Date.now()}.mp3` : undefined),
    content: audioInlineContent ?? content,
    // Task 113 — la clé permanente du tool (archivage à la source) prime :
    // l'artefact est TOUJOURS résolvable via /api/storage/permanent.
    storagePath: audioStoragePath ?? toolPermanentKey ?? storagePath,
    url,
    note,
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
  // Statut HOISTÉ : il est utilisé par finalizeRun ET par recordRunOutcome
  // (bug historique : `const status` déclaré dans le bloc `if` puis lu
  // hors du bloc — ReferenceError à l'exécution, l'action s'exécutait mais
  // l'approbation « échouait » après coup : « Décision impossible. »).
  const status: RunStatus = hasFailure ? "failed" : "completed";
  if (remaining.length === 0) {
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
  // AUTO-AMÉLIORATION : issue de l'action validée enregistrée.
  void recordRunOutcome({
    userId: params.userId,
    objective: approval.title,
    status,
    failedSteps: result.success ? [] : [{ title: approval.title, detail: result.error }],
  }).catch(() => undefined);

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

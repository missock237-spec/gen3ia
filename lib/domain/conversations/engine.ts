import { z } from "zod";

import { runAI, runAIJSON } from "@/lib/engines/ai-engine";
import { generate, generateStream } from "@/lib/ai/router";
import {
  detectImageRatio,
  extractImagePrompt,
  generateImageWithAgnes,
  ImageGenerationError,
  looksLikeExplicitDrawingRequest,
  looksLikeImageRequest,
} from "@/lib/ai/image-generation";
import { enhanceImagePrompt } from "@/lib/ai/image-prompt-enhancer";
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
import { createCustomApi, listEnabledCustomApis, type CustomApiRecord } from "@/lib/integrations/custom-apis/repository";
import { isEmailProviderConfigured } from "@/lib/integrations/email/send";
import { loadImportedFilesContext } from "@/lib/files/import";
import {
  detectScheduleIntent,
  detectServiceControlIntent,
  detectWorkflowIntent,
  type ScheduleIntent,
  type ServiceControlIntent,
  type WorkflowIntent,
} from "./service-intents";

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
  if (toolName.startsWith("voice.")) return "~0,02 € / génération";
  if (toolName === "phone.call") return "selon destination (~0,02 €/min)";
  if (toolName.startsWith("composio.") || toolName.startsWith("mcp.")) return "inclus (application connectée)";
  if (toolName.startsWith("custom_api.")) return "gratuit (votre API — quota du fournisseur)";
  if (toolName === "workflow.run" || (toolName === "workflow.create")) return "gratuit à la création ; exécution facturée selon les modèles";
  if (toolName.startsWith("schedule.") || toolName.startsWith("workflow.")) return "gratuit";
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

export type ExplicitToolIntent =
  | { toolName: "web.search"; query: string }
  | { toolName: "custom_api.call"; query: string }
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

  // 2 bis) Envoi d'email EXPLICITE : verbe d'envoi + mot email + adresse
  // destinataire réellement énoncée. L'envoi réel (Resend) est la demande de
  // l'utilisateur — jamais une réponse « je ne peux pas envoyer d'emails ».
  // Attention : rédiger/brouiller un email (sans envoi ni adresse) ne déclenche PAS le garde.
  const emailSendVerb = /\b(envoi[ez]|envoie|envoyer|exp[ée]di\w*|transmets?|transmets|send)\b/i;
  const emailWord = /\b(e-?mails?|courriels?)\b/i;
  if (catalogNames.has("email.send") && emailSendVerb.test(lower) && emailWord.test(lower)) {
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
  customApis?: CustomApiRecord[],
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
  const emailSection = catalogNames.has("email.send")
    ? [
        "",
        "EMAIL — l'envoi d'emails réels est DISPONIBLE via l'outil email.send (service Resend configuré côté serveur) :",
        "Si l'utilisateur demande d'envoyer/expédier un email (relance, notification, rapport, message à une adresse) : mode=plan avec UN step toolName=\"email.send\" et toolInput { to: \"<adresse exacte énoncée>\", subject: \"<sujet énoncé ou fidèle à la demande>\", text: \"<contenu énoncé ou reformulé fidèlement>\" }.",
        "Ne réponds JAMAIS que tu ne peux pas envoyer d'emails : tu le peux, l'envoi est exécuté par le serveur. N'invente jamais une adresse : utilise uniquement celle que l'utilisateur a énoncée.",
      ].join("\n")
    : "";
  return [
    "Tu es le moteur d'exécution de Gen3ia, une plateforme d'agents avec connecteurs.",
    "Pour chaque demande utilisateur, tu décides :",
    '  mode="chat" : la demande se traite par une simple réponse textuelle (question, explication, rédaction courte). Remplis alors `reply`.',
    '  mode="plan" : la demande exige des actions réelles (recherche, fichiers, applications connectées, publication…). Remplis alors `objective` et 1 à 8 `steps`.',
    "Chaque step avec un toolName doit utiliser EXACTEMENT un des outils du catalogue ci-dessous, avec toolInput conforme à sa description.",
    "Un step sans toolName est une étape de raisonnement/rédaction exécutée par toi-même.",
    "Les outils marqués « validation requise » ne seront exécutés qu'après approbation explicite de l'utilisateur : décris leur impact précisément dans detail.",
    "Ne propose jamais un outil qui n'est pas dans le catalogue. Ne fabrique pas d'identifiants, de tokens ou de numéros.",
    "",
    "RÈGLE IMPÉRATIVE — VISUELS : toute demande de CRÉATION d'image, photo, illustration, dessin, logo, affiche, poster, bannière, avatar, icône, fond d'écran ou miniature est routée en mode=plan avec UN SEUL step :",
    '  { title: "Génération de l\'image", toolName: "image.generate", toolInput: { prompt: "<description visuelle fidèle de CE QUE L\'UTILISATEUR a demandé — le sujet exact, sans rien ajouter ni inventer>" } }.',
    "Cela vaut quel que soit la formulation (« dessine-moi un chat », « je veux une photo de… », « un logo pour ma boulangerie », « fais-moi une image de… »). Ne réponds JAMAIS une demande de visuel par du texte seul.",
    "",
    "Catalogue d'outils disponibles :",
    toolLines,
    "- image.generate (risque low) : génère une image réelle et photoréaliste à partir d'une description visuelle (input { prompt }).",
    "",
    project?.instructions ? `Instructions persistantes du projet « ${project.name} » (à respecter) :\n${project.instructions}` : "",
    project?.privacyRules ? `Règles de confidentialité du projet (impératives) :\n${project.privacyRules}` : "",
    connectorSection,
    customApiSection,
    sousServicesSection,
    emailSection,
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
  /** Mode d'autorisation HITL choisi dans le composer (« Toujours demander ▼ »). */
  authorizationMode?: AuthorizationMode;
  /** Fuseau horaire du client (IANA) pour les tâches planifiées créées en langage naturel. */
  timezone?: string;
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
  const baseCtx: TurnBase = { ...input, conversation, project, projectId, userMessage, priorHistory };
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

  // 1 quater) Contenu RÉEL des fichiers importés (conversion stockée en base).
  // Deux budgets : raccourci pour la classification (latence), complet pour
  // la réponse (le modèle répond sur la pleine teneur).
  const filesContext = await loadImportedFilesContext(input.userId, input.attachments).catch(() => "");
  const filesContextShort = await loadImportedFilesContext(input.userId, input.attachments, { perFile: 2_500, total: 6_000 }).catch(() => "");

  // 2) Demande d'image : génération réelle (Agnes AI) + artefact image.
  // Deux détections déterministes (aucune variance LLM) : verbe + nom
  // visuel, ou verbe de dessin explicite (« Dessine-moi un chat »).
  if (looksLikeImageRequest(input.message) || looksLikeExplicitDrawingRequest(input.message)) {
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
        system: buildIntentSystemPrompt(catalog, project, composioConnectors, customApis),
        prompt:
          `Historique récent :\n${priorHistory.slice(-6).map((m) => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content.slice(0, 500)}`).join("\n") || "(vide)"}` +
          `\n\nNouvelle demande : ${input.message.slice(0, 4000)}${attachmentsContext(input.attachments)}${filesContextShort}`,
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
    const result = await runChatTurn({ ...input, conversation, project, projectId, userMessage, priorHistory, intent, filesContext });
    await onEvent({
      type: "done",
      assistantMessage: result.assistantMessage,
      artifacts: result.artifacts,
      approvals: result.approvals,
    });
    return result;
  }
  const result = await runPlanTurn({ ...input, conversation, project, projectId, userMessage, priorHistory, intent, filesContext });
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
  /** Contenu réel des fichiers importés (convertis + stockés en base). */
  filesContext?: string;
}

interface TurnContext extends TurnBase {
  intent: TurnIntent;
}

async function runChatTurn(ctx: TurnContext): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  const streaming = Boolean(ctx.onEvent);
  const systemParts = [
    "Tu es Gen3ia, l'assistant de travail qui exécute : tu réponds de façon directe, structurée et actionnable.",
    "La génération d'images est effectuée par la plateforme Gen3ia, jamais par toi dans cette réponse : ne prétends JAMAIS avoir généré, affiché ou décrit un visuel comme s'il était affiché, et n'invente jamais d'URL d'image.",
    ctx.project?.instructions ? `Instructions du projet « ${ctx.project.name} » :\n${ctx.project.instructions}` : "",
    ctx.project?.privacyRules ? `Règles de confidentialité impératives :\n${ctx.project.privacyRules}` : "",
    ctx.filesContext ? `Ces contenus proviennent de fichiers importés par l'utilisateur (conversion réelle stockée en base de données) — appuie-toi EXCLUSIVEMENT sur eux pour toute question les concernant, sans jamais inventer de données :${ctx.filesContext}` : "",
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
 */
async function produceConversationImage(
  ctx: Pick<TurnContext, "message">,
  plannedPrompt?: string,
): Promise<{ imageUrl: string; model: string }> {
  const rawPrompt =
    typeof plannedPrompt === "string" && plannedPrompt.trim().length >= 3
      ? plannedPrompt.trim().slice(0, 4000)
      : extractImagePrompt(ctx.message);
  // Amélioration bornée : si le LLM d'amélioration traîne, la génération
  // part avec le prompt d'origine plutôt que de dépasser le budget.
  const enhancement = await withTimeout(
    enhanceImagePrompt(rawPrompt).catch(() => ({ prompt: rawPrompt, enhanced: false })),
    12_000,
    "amélioration du prompt image",
  ).catch(() => ({ prompt: rawPrompt, enhanced: false }));
  const image = await generateImageWithAgnes({
    prompt: enhancement.prompt,
    size: "2K",
    ratio: detectImageRatio(ctx.message),
    timeoutMs: 40_000,
  });
  return { imageUrl: image.imageUrl, model: image.model };
}

async function runImageTurn(ctx: TurnBase): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  try {
    const image = await produceConversationImage(ctx);
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

const TOOL_OUTPUT_ARTIFACTS: ReadonlySet<string> = new Set(["artifact.create", "file.create", "zip.create"]);

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

  try {
    const result = await withTimeout(
      runAIJSON({
        userId: ctx.userId,
        feature: "conversation-turn",
        task: "chat",
        system:
          "Tu rédiges le contenu d'un document professionnel pour l'utilisateur de Gen3ia. " +
          "Tu produis un objet JSON : title (titre court du document), format, blocks (sections). " +
          "Blocs disponibles : title (une seule fois, en premier), heading (sections), paragraph (texte rédigé), " +
          "list (puces {items}), table ({columns, rows}) si des données le justifient, quote, pageBreak. " +
          "Le contenu doit être rédigé intégralement et de façon professionnelle : jamais de placeholder, " +
          "jamais de « … », jamais de section vide.",
        prompt:
          `Demande de l'utilisateur : ${ctx.message.slice(0, 2000)}\n` +
          `Objectif du plan : ${ctx.intent.objective ?? "(celui de la demande)"}\n` +
          `Étape : ${planned.title}${planned.detail ? ` — ${planned.detail}` : ""}\n` +
          `Format attendu : ${typeof toolInput.format === "string" ? toolInput.format : "pdf"}\n` +
          `Titre proposé : ${hasTitle ? String(toolInput.title) : "(à déduire de la demande)"}` +
          `${ctx.priorHistory.length > 0 ? `\n\nContexte récent de la conversation :\n${historyForModel(ctx.priorHistory, 4).map((m) => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content.slice(0, 400)}`).join("\n")}` : ""}`,
        schema: DocumentBlocksSchema,
        label: "redaction-livrable",
        maxTokens: 6000,
      }),
      INTENT_BUDGET_MS,
      "rédaction du livrable",
    );
    const generated = result.data;
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
  /** Image générée pendant ce tour (affichée sur le message final). */
  let turnImageUrl: string | undefined;

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
      const startedAt = new Date().toISOString();
      try {
        const image = await produceConversationImage(ctx, typeof planned.toolInput?.prompt === "string" ? planned.toolInput.prompt : undefined);
        step.status = "done";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = `Image générée avec ${image.model}.`;
        executedSomething = true;
        turnImageUrl = image.imageUrl;
        const artifact = await createArtifact({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          projectId: ctx.projectId,
          runId: run.id,
          type: "image",
          title: (typeof planned.toolInput?.prompt === "string" && planned.toolInput.prompt.trim() ? planned.toolInput.prompt.trim() : ctx.message).slice(0, 80),
          url: image.imageUrl,
          note: `Généré avec ${image.model}`,
        });
        artifacts.push(artifact);
        step.artifactId = artifact.id;
        await onEvent({ type: "artifact_created", artifact });
      } catch (error) {
        step.status = "failed";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = error instanceof ImageGenerationError ? error.message : "La génération d'image a échoué.";
        anyFailure = true;
      }
      await onEvent({ type: "step_update", runId: run.id, step });
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
      continue;
    }

    const toolName = planned.toolName ?? undefined;
    const risk = toolEntry?.risk ?? "low";
    const sensitive = planned.sensitive === true || (toolName ? stepRequiresApproval(risk) : false);

    // Mode « Autoriser automatiquement » : les actions sensibles NON critiques
    // s'exécutent directement (piste d'audit), le plancher de sécurité reste
    // invariant (ads.publish / file.delete / phone.call / risque critical).
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

    if (toolName) {
      const startedAt = new Date().toISOString();
      let toolInput = (planned.toolInput ?? {}) as Record<string, unknown>;
      if (toolName === "artifact.create") {
        // Le contenu du livrable est finalisé juste avant la génération du
        // fichier : jamais de document vide ni d'échec zod opaque.
        const completed = await ensureArtifactInput(ctx, planned, toolInput);
        if (!completed) {
          step.status = "skipped";
          step.detail = `${step.detail ? `${step.detail}\n` : ""}Contenu du livrable indisponible (rédaction impossible pour le moment) — aucun fichier créé.`.trim();
          step.finishedAt = new Date().toISOString();
          await onEvent({ type: "step_update", runId: run.id, step });
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
    ...(turnImageUrl ? { imageUrl: turnImageUrl } : {}),
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
            `Validations en attente : ${approvals.map((a) => `${a.title} — impact : ${a.impact}`).join(" ; ") || "aucune"}` +
            (ctx.filesContext ? `\n\nContenu réel des fichiers importés :${ctx.filesContext}` : ""),
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

import { NextRequest, NextResponse, after } from "next/server";
import { randomUUID } from "crypto";
import { errorStatus } from "@/lib/security/http-errors";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { isFirestoreQuotaError } from "@/lib/db/quota-guard";
import { logger } from "@/lib/observability/logger";
import { ATTACHMENT_MAX_FILES } from "@/lib/files/attachment-policy";
import { loadAgentAttachmentsContext } from "@/lib/files/attachment-context";
import { planUniversalAgent } from "@/lib/agents/runtime/unified-agent";
import { AgentRuntime } from "@/lib/agents/runtime/runner";
import { recordExecutionMetrics } from "@/lib/observability/otel";
import { DEFAULT_EXECUTION_POLICY, type ExecutionPolicy } from "@/lib/security/execution-policy";
import { getToolSecurityDefinition } from "@/lib/security/tool-permissions";
import { createActionApproval, listActionApprovals } from "@/lib/agents/action-approvals";
import { selectApprovalRequiredSteps } from "@/lib/agents/approval-policy";
import type { RuntimePlan } from "@/lib/agents/runtime/types";
import { appendMessage, createConversation, getConversation, listMessages, updateConversation, type ChatConversation } from "@/lib/chat/repository";
import { getAgentForUser } from "@/lib/agents/repository";
import { policyForAgent } from "@/lib/agents/personalized-plan";
import { answerAsAgent, classifyRequest, historyContextNote, unavailableCapabilityReply, planAgentTask } from "@/lib/agents/chat-engine";
import { recordAgentRun } from "@/lib/agents/conversation-run";
import { deliverMissionToConversation } from "@/lib/agents/mission-delivery";
import { createQueuedMission } from "@/lib/queue/mission-queue";
import { missionQueueConfigured, publishMissionTick } from "@/lib/queue/qstash";
import { enqueueMissionContinuation } from "@/lib/queue/mission-continuation";
import { recallAgentContext, recordExchange, shouldSummarize, summarizeConversation } from "@/lib/memory/episodic";
import { describeServersForPrompt } from "@/lib/integrations/mcp/service";
import { describeConnectorsForPrompt, describeConnectedConnectorsForPrompt, type ConnectedConnectorsContext } from "@/lib/integrations/mention";
import { describeProjectServicesForPrompt, PROJECT_SERVICE_TOOLS } from "@/lib/agents/services/bridge";
import {
  generateImageWithAgnes,
  ImageGenerationError,
  isImageGenerationEnabled,
  looksLikeImageRequest,
} from "@/lib/ai/image-generation";
import { extractVideoTitle, extractVoiceRequestText, looksLikeVideoRequest, looksLikeVoiceRequest, resolveVoiceRequestFromContext, type VoiceHistoryTurn } from "@/lib/ai/video-intent";
import { speakDirectForUser } from "@/lib/ai/voice-speak-direct";
import { captureMissionEscrow, reserveMissionEscrow } from "@/lib/billing/mission-escrow";
import { imagesForModel } from "@/lib/ai/vision-input";
import type { AIImageAttachment } from "@/lib/ai/models";
import { createR2DownloadUrl } from "@/lib/storage/r2";
import type { AgentRecord } from "@/lib/agents/schema";
import { buildImageGenerationSkill } from "@/lib/agents/skills/image-generation";

const Body = z.object({
  message: z.string().trim().min(1).max(200_000),
  conversationId: z.string().trim().min(1).max(256).optional(),
  // Chat scopé à un agent personnalisé du Studio : classification,
  // périmètre strict et outils restreints.
  agentId: z.string().trim().min(1).max(128).optional(),
  attachmentPath: z.string().trim().min(1).max(500).optional(),
  attachmentName: z.string().trim().min(1).max(255).optional(),
  // Pièces jointes MULTIPLES (politique unifiée : 10 fichiers × 50 Mo) —
  // pré-téléversées dans le stockage permanent R2 du propriétaire. Le
  // contenu RÉEL est extrait côté serveur et injecté dans le prompt ;
  // l'agent peut aussi relire chaque fichier à la demande via l'outil
  // file.read (clé permanente). Les champs historiques restent acceptés.
  attachments: z.array(z.object({
    path: z.string().trim().min(1).max(500),
    name: z.string().trim().min(1).max(255),
    sizeBytes: z.number().int().nonnegative().max(50 * 1024 * 1024).optional(),
    contentType: z.string().trim().max(160).optional(),
  })).max(ATTACHMENT_MAX_FILES).optional(),
  // Connecteurs activés par l'utilisateur via le sélecteur « @ » du chat :
  // l'agent reçoit le contexte des actions disponibles et peut agir dessus.
  activatedConnectors: z.array(
    z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,64}$/, "connecteur invalide"),
  ).max(10).optional(),
  // Prompts système avancés : fuseau IANA du client (variables {{date}}/
  // {{time}} de la charte résolues dans le fuseau de l'utilisateur ; invalide
  // = repli UTC silencieux).
  timezone: z.string().trim().max(64).optional(),
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
    // CONTRAT Task 107 (lot B) : la sentinelle "*" émise par policyForAgent
    // (niveaux standard/power) signifie « whitelist complète » — sans ce cas,
    // l'intersection Set viderait allowedTools et chaque outil planifié
    // échouerait en « Tool not allowed ». Les exclusions réelles (caps persona,
    // ui.components) arrivent déjà sous forme de liste explicite : le filtrage
    // ci-dessous continue de s'appliquer dans ce cas.
    allowedTools: (planPolicy.allowedTools ?? []).filter((tool) => agentAllowed.has(tool) || agentAllowed.has("*")),
  };
}

/**
 * Politique effective d'une mission agent. Les connecteurs ouverts :
 *  - activés via « @ » lorsqu'ils sont déjà connectés et vérifiés ;
 *  - OU détectés automatiquement au statut « connecté » sur le compte.
 * Une sélection client d'un toolkit non connecté est systématiquement ignorée.
 * Les API personnelles (api-*) activées ouvrent l'écriture via
 * custom_api.write (validation humaine conservée). Reste soumis aux
 * approvals pour les actions à effet externe.
 */
function policyForAgentMission(
  agent: AgentRecord,
  plan: RuntimePlan,
  activatedConnectors: string[],
  connectedToolkits: string[] = [],
  options: { customApiAccess?: boolean } = {},
): ExecutionPolicy {
  const policy = planPolicyForAgent(agent, plan);
  // Les agents accèdent par défaut aux services du projet (documents,
  // fichiers, archives, recherche, mémoire, knowledge base, simulation) :
  // c'est ce qui leur permet d'EXÉCUTER les tâches, pas seulement répondre.
  const withServices = [...new Set([...(policy.allowedTools ?? []), ...PROJECT_SERVICE_TOOLS])];
  const permissions = [...policy.permissions];
  if (options.customApiAccess) {
    // L'utilisateur a explicitement activé (ou possède) des API personnelles :
    // l'écriture reste soumise à la validation humaine (risque external).
    withServices.push("custom_api.write");
    permissions.push("tool.external", "network.write");
  }
  if (activatedConnectors.length === 0 && connectedToolkits.length === 0) {
    return { ...policy, allowedTools: withServices, permissions };
  }
  return {
    ...policy,
    allowedTools: [...new Set([...withServices, "composio.execute"])],
    permissions,
  };
}

/**
 * VISION : convertit les pièces jointes image du message en parts vision
 * réelles — une clé R2 est résolue en URL signée https (courte durée), une
 * URL https passe telle quelle. Purement additif : sans image exploitable,
 * undefined (rétrocompatible, aucun appel réseau inutile).
 */
async function visionImagesFor(
  attachments?: Array<{ path: string; name: string; sizeBytes?: number; contentType?: string }>,
  legacy?: { path?: string; name?: string } | null,
): Promise<AIImageAttachment[] | undefined> {
  const candidates = [
    ...(legacy?.path ? [{ path: legacy.path, name: legacy.name ?? legacy.path, contentType: (undefined as string | undefined) }] : []),
    ...(attachments ?? []).map((item) => ({ path: item.path, name: item.name, contentType: item.contentType as string | undefined })),
  ];
  const resolved: MessageAttachmentLike[] = [];
  for (const candidate of candidates) {
    const isImage = (candidate.contentType ?? "").startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(candidate.name);
    if (!isImage) continue;
    let url: string | undefined;
    if (/^https:\/\//i.test(candidate.path)) {
      url = candidate.path;
    } else {
      try {
        url = await createR2DownloadUrl(candidate.path, 600);
      } catch {
        continue; // résolution impossible : cette image est écartée
      }
    }
    resolved.push({ filename: candidate.name, url, ...(candidate.contentType ? { contentType: candidate.contentType } : {}) });
  }
  return imagesForModel(resolved);
}

interface MessageAttachmentLike {
  filename: string;
  url?: string;
  contentType?: string;
}

/**
 * Réponse NDJSON de PROGRESSION pour les générations médias de l'agent :
 * chaque étape réelle émet un événement {type:"progress",...} et le résultat
 * final part en {type:"result", data}. Le client lit le flux en direct —
 * cadre de progression RÉEL (stages serveur), jamais une fausse barre.
 */
function mediaProgressResponse(run: (report: (event: { label: string; stage: string; percent: number }) => Promise<void> | void) => Promise<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };
      try {
        const data = await run(async (event) => {
          send({ type: "progress", ...event });
        });
        send({ type: "result", data });
      } catch (error) {
        send({ type: "stream_error", message: error instanceof Error ? error.message : "Erreur inconnue" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

/** Note de contexte (mémoire de l'agent) — les pièces jointes passent par loadAgentAttachmentsContext. */
function memoryNoteFor(agent: AgentRecord | null): string | undefined {
  if (agent?.memoryFile?.path) {
    return `[Mémoire de l'agent : le fichier « ${agent.memoryFile.name} » (${agent.memoryFile.path}) est disponible dans le stockage permanent Gen3ia (lecture réelle via l'outil file.read, input { path }) dès qu'il peut améliorer ta réponse.]`;
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
  /** Rapport de progression RÉEL (amélioration → génération → enregistrement). */
  onProgress?: (event: { label: string; stage: string; percent: number }) => Promise<void> | void;
}): Promise<{ reply: string; imageUrl: string | undefined; model: string | undefined }> {
  const { userId, conversationId, message, onProgress } = params;
  if (!isImageGenerationEnabled()) {
    const reply = "La génération d'images n'est pas encore disponible sur la plateforme. Réessayez bientôt.";
    await appendMessage({ conversationId, userId, role: "assistant", content: reply });
    return { reply, imageUrl: undefined, model: undefined };
  }
  try {
    await onProgress?.({ label: "Amélioration du prompt visuel…", stage: "enhance", percent: 15 });
    const imageSkill = buildImageGenerationSkill(message);
    await onProgress?.({ label: "Génération de l'image en cours…", stage: "generating", percent: 40 });
    const image = await generateImageWithAgnes({ prompt: imageSkill.prompt, ratio: imageSkill.ratio });
    await onProgress?.({ label: "Finalisation de l'image…", stage: "persisting", percent: 85 });
    const reply = "";
    await appendMessage({
      conversationId, userId, role: "assistant", content: reply,
      imageUrl: image.imageUrl, provider: "agnes", model: image.model,
    });
    await onProgress?.({ label: "Image prête.", stage: "complete", percent: 100 });
    return { reply, imageUrl: image.imageUrl, model: image.model };
  } catch (error) {
    const reply = error instanceof ImageGenerationError
      ? error.message
      : "La génération d'image a échoué. Réessayez dans un instant.";
    await appendMessage({ conversationId, userId, role: "assistant", content: reply });
    return { reply, imageUrl: undefined, model: undefined };
  }
}

/**
 * VOIX-OFF DIRECTE (Task 114-a) : synthèse ElevenLabs immédiate — même
 * mécanique d'archivage permanent R2 que l'outil voice.speak (clé réutilisable
 * par le canal signé de l'application), facturation TTS au réel. Le message
 * assistant porte le lien d'écoute (URL signée R2). Retourne spoken=false en
 * échec de synthèse/facturation — l'appelant continue le flux normal (jamais
 * d'échec visible brut).
 */
async function respondWithVoiceOff(params: {
  userId: string;
  conversationId: string;
  text: string;
}): Promise<{ spoken: boolean; reply?: string; audio?: { url?: string; storage: "r2" | "inline"; dataUri?: string } }> {
  const executionId = `voice_direct_${params.conversationId}`;
  const result = await speakDirectForUser({ userId: params.userId, text: params.text, executionId });
  if (!result.ok) return { spoken: false };

  // Lien d'écoute : URL signée R2 (6 h) quand l'audio est archivé. En repli
  // inline, le data URI reste dans la réponse API (audio.dataUri) — la base64
  // n'est jamais déversée dans le fil (rendu markdown du chat limité à https).
  let playableUrl: string | undefined;
  if (result.storage === "r2" && result.audioUrl) {
    // Lien d'écoute : URL signée R2 (1 h, plafond du presigneur — une
    // expiration supérieure lève et faisait silencieusement DISPARAÎTRE le
    // lien d'écoute). La clé R2 permanente reste la référence durable.
    playableUrl = await createR2DownloadUrl(result.audioUrl, 3600).catch(() => undefined);
  }
  const reply = [
    "Voici votre voix-off, synthétisée avec une voix naturelle ElevenLabs.",
    result.storage === "r2"
      ? "L'audio est archivé en permanence dans votre espace : il reste disponible et réutilisable."
      : "L'archivage permanent est momentanément indisponible : l'audio est livré dans la réponse de cette conversation (version temporaire).",
    ...(playableUrl ? ["", `[Écouter l'audio](${playableUrl})`] : []),
  ].join("\n");
  await appendMessage({ conversationId: params.conversationId, userId: params.userId, role: "assistant", content: reply });
  return {
    spoken: true,
    reply,
    audio: {
      ...(result.audioUrl ? { url: result.audioUrl } : {}),
      storage: result.storage ?? "inline",
      ...(result.dataUri ? { dataUri: result.dataUri } : {}),
    },
  };
}

/**
 * Intercept VOIX-OFF (Task 114-a + fix capture 13:02) : une demande explicite
 * de voix-off avec un texte identifiable est servie IMMÉDIATEMENT (synthèse +
 * message assistant), avant tout routage de mission — miroir de l'intercept
 * vidéo. SUIVI CONTEXTUEL : la réponse de l'utilisateur à une question de
 * clarification (« quel texte ? ») est synthétisée telle quelle. Demande
 * d'audio SANS texte → question de clarification DÉTERMINISTE (zéro LLM,
 * zéro refus, zéro tuto externe). Retourne spoken/clarify à livrer, ou
 * undefined pour laisser le flux normal continuer (demande vidéo, texte non
 * extractible, synthèse/facturation indisponibles).
 */
async function interceptVoiceOff(params: {
  userId: string;
  conversationId: string;
  message: string;
  /** Fil AVANT le message courant (chronologique) pour le suivi contextuel. */
  history?: VoiceHistoryTurn[];
}): Promise<{ kind: "spoken"; reply: string; audio: { url?: string; storage: "r2" | "inline"; dataUri?: string } } | { kind: "clarify"; reply: string } | undefined> {
  // 1) Suivi contextuel : réponse au « quel texte voulez-vous entendre ? ».
  const contextVoice = resolveVoiceRequestFromContext(params.message, params.history ?? []);
  if (contextVoice) {
    try {
      const spoken = await respondWithVoiceOff({
        userId: params.userId,
        conversationId: params.conversationId,
        text: contextVoice.text2speak,
      });
      if (spoken.spoken && spoken.audio) {
        return { kind: "spoken", reply: spoken.reply ?? "Voici votre audio.", audio: spoken.audio };
      }
    } catch (voiceError) {
      logger.warn({ err: voiceError instanceof Error ? voiceError.message : voiceError }, "agent_chat_voice_context_failed");
    }
    // Synthèse impossible : le flux normal prend le relais (réponse LLM).
    return undefined;
  }
  if (!looksLikeVoiceRequest(params.message)) return undefined;
  const voiceRequest = extractVoiceRequestText(params.message);
  if (!voiceRequest) {
    // 2) Demande d'audio SANS texte identifiable : clarification déterministe
    // (jamais de refus ni de tuto externe — la plateforme synthétise l'audio).
    const reply = [
      "Avec plaisir — je peux synthétiser votre audio dès maintenant (voix naturelle ElevenLabs, archivée dans votre espace).",
      "Quel texte ou quel contenu souhaitez-vous entendre dans cet audio ? Répondez directement avec le texte : je le synthétise immédiatement.",
    ].join("\n");
    await appendMessage({ conversationId: params.conversationId, userId: params.userId, role: "assistant", content: reply });
    return { kind: "clarify", reply };
  }
  try {
    const spoken = await respondWithVoiceOff({
      userId: params.userId,
      conversationId: params.conversationId,
      text: voiceRequest.text2speak,
    });
    if (!spoken.spoken || !spoken.audio) return undefined;
    return { kind: "spoken", reply: spoken.reply ?? "Voici votre voix-off.", audio: spoken.audio };
  } catch (voiceError) {
    logger.warn({ err: voiceError instanceof Error ? voiceError.message : voiceError }, "agent_chat_voice_off_intercept_failed");
    return undefined;
  }
}

export const runtime = "nodejs";
// Fenêtre du repli SYNCHRONE (file non configurée) : les missions longues
// sont coupées PROPREMENT par batchDeadlineMs avant la fin de fenêtre, puis
// enfilées dans la file pour continuation arrière-plan.
export const maxDuration = 300;

/** Budget de tranche synchrone (marge 10 s sous la fenêtre). */
const MISSION_SYNC_BUDGET_MS = 290_000;

/** Message utilisateur enrichi des pièces jointes (persistance complète). */
function attachmentsForMessage(attachments?: Array<{ path: string; name: string; sizeBytes?: number; contentType?: string }>, legacy?: { path?: string; name?: string }) {
  const list = [
    ...(legacy?.path ? [{ filename: legacy.name ?? legacy.path, path: legacy.path }] : []),
    ...(attachments ?? []).map((item) => ({
      filename: item.name,
      path: item.path,
      ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
      ...(item.contentType ? { contentType: item.contentType } : {}),
    })),
  ];
  return list.length > 0 ? list : undefined;
}

/**
 * Lance une mission en mode task SUR LA FILE QStash quand elle est
 * disponible : l'exécution est 100 % serveur, par tranches de 50 s, et la
 * mission NE MEURT JAMAIS avec l'onglet (refresh, fermeture, suppression —
 * exigence production). Le run conversationnel est enregistré AVANT
 * l'exécution (suivi live), le message final + les livrables + la
 * notification sont livrés par le tick final.
 */
async function launchQueuedTaskMission(input: {
  userId: string;
  conversationId: string;
  objective: string;
  plan: RuntimePlan;
  projectId?: string;
  orgId?: string;
}): Promise<{ queued: boolean; runId?: string; reason?: string; escrowRejected?: boolean }> {
  if (!missionQueueConfigured()) {
    return { queued: false, reason: "File d'attente non configurée." };
  }
  const runId = randomUUID();
  // ESCROW V2 (Task 114-a) : le frais de résultat est RÉSERVÉ au lancement —
  // fonds insuffisants → la mission n'est PAS créée (l'appelant répond 402).
  // Panne d'infrastructure → fail-soft : la mission démarre (capture en
  // rattrapage prévue à la livraison).
  const escrow = await reserveMissionEscrow({ userId: input.userId, executionId: input.plan.executionId, runId });
  if (!escrow.ok) {
    return { queued: false, escrowRejected: true, reason: "Solde insuffisant pour lancer cette mission." };
  }
  try {
    await createQueuedMission({
      runId,
      executionId: input.plan.executionId,
      userId: input.userId,
      objective: input.objective,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.orgId ? { orgId: input.orgId } : {}),
      conversationId: input.conversationId,
      plan: input.plan,
    });
    // Run conversationnel AVANT exécution : le suivi live (polling des runs
    // du fil) montre le plan et les étapes dès les premières secondes.
    try {
      await recordAgentRun({
        userId: input.userId,
        conversationId: input.conversationId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        plan: input.plan,
        status: "running",
        outputs: {},
        observations: [],
        billing: { currency: "XAF", totalChargeMinor: 0, totalProviderCostEur: 0, llmInputTokens: 0, llmOutputTokens: 0 },
      });
    } catch (runError) {
      console.warn("[agent-chat] run initial non enregistré", runError instanceof Error ? runError.message : runError);
    }
    // ORIGINE CANONIQUE (fix CodeQL request-forgery) : publishMissionTick
    // résout GEN3IA_APP_ORIGIN en interne (allowlist serveur) — la
    // destination n'est jamais dérivée de la requête entrante.
    await publishMissionTick(runId);
    return { queued: true, runId };
  } catch (error) {
    console.warn("[agent-chat] enfilement impossible — repli synchrone", error instanceof Error ? error.message : error);
    return { queued: false, reason: error instanceof Error ? error.message : "Enfilement impossible." };
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const chatLimit = await enforceRateLimit(`agent-chat:${user.uid}`, { limit: 60, windowMs: 5 * 60 * 1000 });
    if (!chatLimit.allowed) {
      return NextResponse.json({ error: "Trop de messages rapproches. Reessayez dans quelques instants." }, { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(chatLimit.retryAfterMs / 1000))) } });
    }
    const body = Body.parse(await request.json());

    let agent: AgentRecord | null = null;
    if (body.agentId) {
      agent = await getAgentForUser(user.uid, body.agentId);
      if (!agent) return NextResponse.json({ error: "Agent introuvable." }, { status: 404 });
      if (agent.status !== "active") {
        return NextResponse.json({ error: `L'agent est ${agent.status}. Activez-le avant de discuter.` }, { status: 409 });
      }
    }

    const existing = body.conversationId ? await getConversation(user.uid, body.conversationId) : null;
    if (body.conversationId && !existing) {
      return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
    }
    let conversation: ChatConversation;
    let conversationId: string;
    if (existing) {
      conversationId = body.conversationId!;
      if (agent && !existing.agentId) {
        // Fils legacy créés sans agentId : rattachement rétroactif à l'agent
        // courant pour que l'historique scopé les retrouve.
        await updateConversation(user.uid, conversationId, { agentId: agent.id });
        conversation = { ...existing, agentId: agent.id };
      } else {
        conversation = existing;
      }
    } else {
      // Historique mémorisé : un fil ouvert depuis le chat d'un agent est
      // créé AVEC son agentId — le rail « Historique des chats » de l'agent
      // liste ainsi ses propres fils (scoping par agentId côté repository).
      conversation = await createConversation(user.uid, body.message.slice(0, 80), agent ? { agentId: agent.id } : {});
      conversationId = conversation.id;
    }
    // Nombre réel de messages du fil (au-delà de la fenêtre chargée) : pilote
    // la cadence de résumé épisodique même sur les conversations longues.
    const priorMessageCount = conversation.messageCount ?? 0;

    // Historique AVANT l'ajout du message courant (contexte de classification
    // et de réponse en mode chat) — les PLUS RÉCENTS, ordre chronologique :
    // une conversation longue ne doit jamais amputer le contexte de sa fin.
    const history = await listMessages(user.uid, conversationId, 30, { order: "recent" });

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
      // Compat : ancien champ unique + nouveau tableau multi-fichiers.
      const chatAttachments = [
        ...(body.attachmentPath ? [{ path: body.attachmentPath, name: body.attachmentName ?? body.attachmentPath }] : []),
        ...(body.attachments ?? []),
      ];
      await appendMessage({
        conversationId,
        userId: user.uid,
        role: "user",
        content: body.message,
        ...(attachmentsForMessage(body.attachments, { path: body.attachmentPath, name: body.attachmentName }) ? { attachments: attachmentsForMessage(body.attachments, { path: body.attachmentPath, name: body.attachmentName }) } : {}),
      });
      // VOIX-OFF DIRECTE (Task 114-a + fix capture 13:02) : une demande
      // explicite de voix-off (ou la réponse au « quel texte ? ») est
      // synthétisée IMMÉDIATEMENT (ElevenLabs + archivage permanent), avant
      // tout routage de mission. Demande d'audio SANS texte → clarification
      // déterministe (jamais de refus ni de tuto externe). Le flux normal
      // continue si la synthèse n'est pas possible (jamais d'échec visible).
      const voiceOff = await interceptVoiceOff({
        userId: user.uid,
        conversationId,
        message: body.message,
        history: history.map((item) => ({ role: item.role, content: item.content })),
      });
      if (voiceOff?.kind === "clarify") {
        after(() => recordExchange({ userId: user.uid, agentId: agent.id, conversationId, userMessage: body.message, assistantReply: voiceOff.reply, mode: "chat" }));
        return NextResponse.json({
          mode: "chat",
          conversationId,
          agentId: agent.id,
          classification: { mode: "chat" as const, inScope: true, reason: "Voix-off" },
          reply: voiceOff.reply,
        });
      }
      if (voiceOff) {
        after(() => recordExchange({ userId: user.uid, agentId: agent.id, conversationId, userMessage: body.message, assistantReply: voiceOff.reply, mode: "chat" }));
        return NextResponse.json({
          mode: "chat",
          conversationId,
          agentId: agent.id,
          classification: { mode: "chat" as const, inScope: true, reason: "Voix-off" },
          reply: voiceOff.reply,
          audio: voiceOff.audio,
        });
      }
      // PRODUCTION VIDÉO (autopilote) : une demande explicite de vidéo lance
      // la file de production RÉELLE (projet → plan → scénario → visuels →
      // voix → rendu) — le client suit la progression via l'API production.
      if (looksLikeVideoRequest(body.message)) {
        try {
          const { createVideoProductionJob } = await import("@/lib/video/production-queue");
          const job = await createVideoProductionJob({
            userId: user.uid,
            prompt: body.message.trim().slice(0, 4000),
            title: extractVideoTitle(body.message),
          });
          const reply = [
            "Votre production vidéo est lancée. Enchaînement automatique : plan du réalisateur, scénario, visuels de scènes, narration, musique, montage et rendu final avec contrôle qualité.",
            `Le cadre de progression affiché ici suit la production RÉELLE en temps réel. Projet complet dans l'atelier vidéo : /studio/video/${job.projectId}`,
          ].join("\n");
          await appendMessage({ conversationId, userId: user.uid, role: "assistant", content: reply });
          after(() => recordExchange({ userId: user.uid, agentId: agent.id, conversationId, userMessage: body.message, assistantReply: reply, mode: "chat" }));
          return NextResponse.json({
            mode: "chat",
            conversationId,
            agentId: agent.id,
            classification: { mode: "chat" as const, inScope: true, reason: "Production vidéo" },
            reply,
            videoProject: { projectId: job.projectId, jobId: job.jobId },
          });
        } catch (videoError) {
          const unavailable = videoError instanceof Error && /n.est pas disponible/.test(videoError.message);
          const reply = unavailable
            ? "La production vidéo n'est pas disponible sur cette plateforme actuellement (moteur de production non configuré). Réessayez plus tard."
            : "Le lancement de la production vidéo a échoué. Réessayez dans un instant.";
          await appendMessage({ conversationId, userId: user.uid, role: "assistant", content: reply });
          return NextResponse.json({
            mode: "chat",
            conversationId,
            agentId: agent.id,
            classification: { mode: "chat" as const, inScope: true, reason: "Production vidéo" },
            reply,
          });
        }
      }

      // Génération d'images réelle (Agnes AI) : une demande explicite d'image
      // est servie directement, quel que soit le type d'agent — c'est une
      // capacité de la plateforme, pas du LLM conversationnel. Réponse en
      // NDJSON : chaque étape réelle émet un événement de progression
      // (cadre temps réel côté client).
      if (looksLikeImageRequest(body.message)) {
        return mediaProgressResponse(async (report) => {
          const imageResult = await respondWithImage({
            userId: user.uid,
            conversationId,
            message: body.message,
            agentId: agent.id,
            onProgress: report,
          });
          after(() => recordExchange({ userId: user.uid, agentId: agent.id, conversationId, userMessage: body.message, assistantReply: imageResult.reply, mode: "chat" }));
          return {
            mode: "chat",
            conversationId,
            agentId: agent.id,
            classification: { mode: "chat" as const, inScope: true, reason: "Génération d'image" },
            reply: imageResult.reply,
            imageUrl: imageResult.imageUrl,
          };
        });
      }

      // CONTENU RÉEL des pièces jointes (exigence production) : chaque
      // fichier du stockage permanent est téléchargé et converti côté
      // serveur ; le contenu extrait nourrit la réponse ET la planification.
      // Fail-soft : un fichier illisible n'empêche jamais la réponse.
      // (Chargé AVANT la classification : le classificateur décide en voyant
      // le même contexte que la réponse — plus de décision sur un message
      // isolé ignorant les fichiers fournis.)
      const attachmentsContext = chatAttachments.length > 0
        ? await loadAgentAttachmentsContext(user.uid, chatAttachments).catch(() => ({ note: "", files: [] }))
        : { note: "", files: [] };
      const note = [attachmentsContext.note, memoryNoteFor(agent)].filter(Boolean).join("\n\n") || undefined;

      // Classification AVEC l'historique récent ET le contexte réel des
      // pièces jointes : le classificateur résout les références implicites
      // (« ce fichier », « la même chose ») au lieu de décider hors contexte.
      const classification = await classifyRequest(
        agent,
        body.message,
        history.map((item) => ({ role: item.role, content: item.content })),
        note,
      );

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
      // Défense serveur : une sélection envoyée par le client n'accorde aucun
      // accès. Seuls les toolkits déjà vérifiés/connectés sont retenus.
      // Exception : les API personnelles (api-*) — elles appartiennent à
      // l'utilisateur ; les outils custom_api.* ne peuvent de toute façon
      // résoudre QUE les API de cet utilisateur.
      const requestedConnectors = body.activatedConnectors ?? [];
      const requestedApis = requestedConnectors.filter((slug) => slug.startsWith("api-"));
      const requestedComposio = requestedConnectors.filter((slug) => !slug.startsWith("api-"));
      const activatedConnectors = requestedComposio.filter((toolkit) => connected.toolkits.includes(toolkit));
      // API personnelles sélectionnées : vérifiées réellement en base.
      let selectedApiNote: string | undefined;
      let hasCustomApiAccess = false;
      try {
        const { listEnabledCustomApis } = await import("@/lib/integrations/custom-apis/repository");
        const enabledApis = await listEnabledCustomApis(user.uid, 12);
        hasCustomApiAccess = enabledApis.length > 0;
        const selected = requestedApis
          .map((slug) => enabledApis.find((api) => slug === `api-${api.id}`))
          .filter((api): api is NonNullable<typeof api> => Boolean(api));
        if (selected.length > 0) {
          hasCustomApiAccess = true;
          selectedApiNote = [
            "API personnelles ACTIVÉES pour ce message (appels HTTP réels) :",
            ...selected.map((api) => `- « ${api.name} » — base : ${api.baseUrl} (auth : ${api.authType})`),
            "Interrogez-les avec des étapes tool toolName=\"custom_api.call\" (input { apiName, path }) ; modifications via \"custom_api.write\" (validation requise).",
          ].join("\n");
        }
      } catch {
        // API personnelles indisponibles : le reste du chat fonctionne.
      }
      const selectedNote = activatedConnectors.length > 0
        ? await describeConnectorsForPrompt(user.uid, activatedConnectors)
        : undefined;
      const connectorsNote = [connected.note, selectedNote, selectedApiNote].filter(Boolean).join("\n\n") || undefined;
      // Services du projet : catalogue injecté pour que le planificateur
      // sache quels services (documents, fichiers, recherche, mémoire…)
      // sont utilisables et comment les nommer.
      const servicesNote = describeProjectServicesForPrompt();
      const fullNote = [note, memoryNote, mcpNote, connectorsNote, servicesNote].filter(Boolean).join("\n\n") || undefined;

      // Demande MATERIELLEMENT IMPOSSIBLE (aucune capacité disponible même
      // avec les outils fournis) : réponse honnête déterministe, sans coût
      // LLM. Une demande hors spécialité N'EST PAS bloquée ici : les agents
      // Gen3ia sont polyvalents (charte « PÉRIMÈTRE & POLYVALENCE ») et le
      // classificateur ne renvoie inScope:false QUE pour l'impossible.
      if (!classification.inScope) {
        const reply = unavailableCapabilityReply(agent, body.message);
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
      // [clarify] Canal de clarification : le classificateur peut renvoyer
      // UNE question (française) quand la demande est réellement ambiguë
      // entre deux actions matériellement différentes et qu'aucun choix par
      // défaut raisonnable n'existe — on la répond telle quelle au lieu de
      // deviner une action à exécuter (jamais pour une simple question).
      if (classification.mode === "chat" && classification.clarifyingQuestion) {
        const reply = classification.clarifyingQuestion;
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
      if (classification.mode === "chat") {
        // VISION : les images jointes au message sont transmises au modèle
        // (URLs R2 signées — parts vision réelles).
        const visionImages = await visionImagesFor(body.attachments, body.attachmentPath ? { path: body.attachmentPath, name: body.attachmentName ?? body.attachmentPath } : null);
        const reply = await answerAsAgent(
          user.uid,
          agent,
          history.map((item) => ({ role: item.role, content: item.content })),
          body.message,
          fullNote,
          {
            // Prompts système avancés : variables dynamiques résolues avec le
            // contexte réel (fuseau client, utilisateur connecté).
            userName: user.name ?? user.email?.split("@")[0],
            userEmail: user.email,
            timezone: body.timezone,
          },
          visionImages,
        );
        await appendMessage({ conversationId, userId: user.uid, role: "assistant", content: reply });
        after(() => recordExchange({ userId: user.uid, agentId: agent.id, conversationId, userMessage: body.message, assistantReply: reply, mode: "chat" }));
        if (agent.memoryEnabled && shouldSummarize(priorMessageCount + 2)) {
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
      // Note de contexte conversationnelle : le planificateur reçoit les
      // échanges récents pour comprendre le VRAI besoin (références
      // implicites : « le PDF dont on parlait », « le même format »).
      const historyNote = historyContextNote(history.map((item) => ({ role: item.role, content: item.content })));
      const objectiveNote = [fullNote, historyNote, body.message].filter(Boolean).join("\n\n");
      const plan = await planAgentTask(user.uid, agent, objectiveNote);
      // APPROBATION CONDITIONNELLE : app externe connectée = exécution directe ;
      // approbation seulement si l'app est non connectée (plancher de sécurité
      // invariant conservé : ads.publish, file.delete, phone.call).
      const approvalSteps = await selectApprovalRequiredSteps(user.uid, plan.steps);

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

        // Timeline persistée sur le fil : la mission en attente d'approbation
        // reste visible à la réouverture (plan + étapes en attente).
        let waitingRunId: string | undefined;
        try {
          waitingRunId = await recordAgentRun({
            userId: user.uid,
            conversationId,
            projectId: agent.projectId,
            plan,
            status: "waiting_approval",
            outputs: {},
            observations: [],
            billing: checkpoint.billing,
          });
        } catch (runError) {
          // Observabilité fail-soft (Task 96-c) : un échec d'écriture du run
          // ne doit JAMAIS transformer une réponse IA en 400 — pino remplace
          // console.warn (cohérence des journaux structurés).
          logger.warn({ err: runError instanceof Error ? runError.message : runError }, "agent_chat_run_waiting_not_recorded");
        }

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

        const waitingText = `J'ai préparé le plan d'exécution (${classification.reason || "tâche confirmée"}). Une ou plusieurs actions externes nécessitent votre confirmation avant exécution.`;
        await appendMessage({ conversationId, userId: user.uid, role: "assistant", content: waitingText, ...(waitingRunId ? { runId: waitingRunId } : {}) });

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

      // EXIGENCE PRODUCTION : la mission part SUR LA FILE quand elle est
      // configurée — l'exécution est 100 % serveur (tranches de 50 s) et
      // continue même si l'utilisateur actualise, ferme ou supprime l'onglet.
      // Le tick final livre le message, les livrables et la notification.
      const queuedLaunch = await launchQueuedTaskMission({
        userId: user.uid,
        conversationId,
        objective: body.message,
        plan,
        projectId: agent.projectId,
        orgId: agent.orgId,
      });
      // ESCROW V2 : fonds insuffisants au lancement → 402 canonique, la
      // mission n'a PAS été créée. Message laissé sur le fil pour cohérence.
      if (queuedLaunch.escrowRejected) {
        const reply = "Solde insuffisant pour lancer cette mission. Rechargez votre portefeuille.";
        await appendMessage({ conversationId, userId: user.uid, role: "assistant", content: reply }).catch(() => undefined);
        return NextResponse.json({ error: reply, reason: "insufficient_funds" }, { status: 402 });
      }
      if (queuedLaunch.queued) {
        return NextResponse.json({
          mode: "agent",
          status: "queued",
          runId: queuedLaunch.runId,
          executionId: plan.executionId,
          conversationId,
          agentId: agent.id,
          classification,
          objective: body.message,
          plan,
          pollSeconds: 2,
        }, { status: 202 });
      }

      // Repli SYNCHRONE (file indisponible) : exécution dans la requête mais
      // DÉTACHÉE du client (pas de signal) — un refresh ne tue plus la
      // mission ; l'échéance de tranche coupe proprement puis la suite est
      // enfilée en arrière-plan (enqueueMissionContinuation).
      // Timeline persistée AVANT exécution : suivi live dès les premières
      // secondes, réconcilié à la fin (deliverMissionToConversation).
      let syncRunId: string | undefined;
      try {
        syncRunId = await recordAgentRun({
          userId: user.uid,
          conversationId,
          projectId: agent.projectId,
          plan,
          status: "running",
          outputs: {},
          observations: [],
          billing: { currency: "XAF", totalChargeMinor: 0, totalProviderCostEur: 0, llmInputTokens: 0, llmOutputTokens: 0 },
        });
      } catch (runError) {
        // Fail-soft (Task 96-c) : la timeline peut être réconciliée plus tard
        // (reconcileAgentRun) — la mission démarre même sans run initial.
        logger.warn({ err: runError instanceof Error ? runError.message : runError }, "agent_chat_run_initial_not_recorded");
      }

      const runtime = new AgentRuntime({
        userId: user.uid,
        projectId: agent.projectId,
        objective: body.message,
        plan,
        policy: policyForAgentMission(agent, plan, activatedConnectors, connected.toolkits, { customApiAccess: hasCustomApiAccess }),
        // PAS de signal requête : l'utilisateur qui quitte/rafraîchit la page
        // n'exprime PAS un arrêt — la mission continue serveur. L'arrêt
        // explicite passe par /api/agent/chat/stop (contrôle Firestore).
        batchDeadlineMs: Date.now() + MISSION_SYNC_BUDGET_MS,
        agent: {
          agentId: agent.id,
          name: agent.name,
          type: agent.type,
          systemPrompt: agent.systemPrompt,
          provider: agent.modelStrategy === "fixed" ? agent.preferredProvider : undefined,
          model: agent.modelStrategy === "fixed" ? agent.preferredModel : undefined,
          // Cloisonnement multi-tenant (Task 58) : l'exécution porte
          // l'organisation de l'agent (facturation et vues par org).
          orgId: agent.orgId,
        },
      });

      let result;
      try {
        result = await runtime.run();
      } catch (error) {
        // ESCROW V2 : mission échue → le frais de résultat réservé est LIBÉRÉ
        // (fail-soft — l'échec visible reste inchangé).
        await captureMissionEscrow({ userId: user.uid, executionId: plan.executionId, missionStatus: "failed" }).catch(() => undefined);
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
          // Le checkpoint est persisté (travail partiel conservé) : l'UI
          // propose « Continuer la mission » au lieu d'un simple « réessayez ».
          resumable: true,
          approvals: await listActionApprovals(user.uid, plan.executionId),
        }, { status: errorStatus(error, 400) });
      }

      // Métriques OTel (Task 59) : coût par organisation (no-op si export désactivé).
      recordExecutionMetrics({
        executionId: plan.executionId,
        status: result.status,
        orgId: agent.orgId,
        userId: user.uid,
        agentId: agent.id,
        chargeMinor: result.billing.totalChargeMinor,
        providerCostEur: result.billing.totalProviderCostEur,
        inputTokens: result.billing.llmInputTokens,
        outputTokens: result.billing.llmOutputTokens,
      });

      const currentApprovals = await listActionApprovals(user.uid, plan.executionId);
      const pending = currentApprovals.filter((item) => item.status === "pending");
      const status = pending.length > 0 ? "waiting_approval" : result.status;

      // LIVRAISON UNIFIÉE : run réconcilié + message final honnête +
      // manifest des livrables réels. Best-effort — jamais bloquant.
      const delivery = await deliverMissionToConversation({
        userId: user.uid,
        conversationId,
        state: result,
        projectId: agent.projectId,
        ...(syncRunId ? { runId: syncRunId } : {}),
        ...(status === "waiting_approval" ? { overrideClosingText: "J'ai exécuté les étapes autorisées. Une ou plusieurs actions nécessitent maintenant votre confirmation." } : {}),
      }).catch(() => ({ finalText: undefined as string | undefined, deliverables: [], messageId: undefined }));

      // ESCROW V2 : capture (réussite) / libération (échec/annulation) du
      // frais de résultat — statut terminal uniquement (décision interne),
      // idempotent et fail-soft (jamais bloquant pour la réponse).
      await captureMissionEscrow({ userId: user.uid, executionId: result.executionId, missionStatus: result.status });

      // CONTINUATION ARRIÈRE-PLAN : la tranche synchrone a atteint son
      // échéance avec des étapes restantes → la suite part sur la file.
      // L'utilisateur peut fermer l'onglet : la mission continue.
      let continuation: { queued: boolean; runId?: string; reason?: string } | undefined;
      if (result.status === "paused" && result.plan.steps.some((step) => step.status === "pending")) {
        continuation = await enqueueMissionContinuation({
          userId: user.uid,
          executionId: result.executionId,
          objective: result.objective || body.message,
          plan: result.plan,
          projectId: agent.projectId,
          orgId: agent.orgId,
          conversationId,
        });
      }
      const finalText = delivery.finalText;
      const taskReply = status === "waiting_approval"
        ? "J'ai exécuté les étapes autorisées. Une ou plusieurs actions nécessitent maintenant votre confirmation."
        : undefined;
      after(() => recordExchange({ userId: user.uid, agentId: agent.id, conversationId, userMessage: body.message, assistantReply: taskReply ?? finalText ?? "", mode: "task" }));

      return NextResponse.json({
        mode: "agent",
        status,
        ...(syncRunId ? { runId: syncRunId } : {}),
        executionId: result.executionId,
        conversationId,
        agentId: agent.id,
        classification,
        objective: result.objective,
        plan: result.plan,
        observations: result.observations,
        outputs: result.outputs,
        billing: result.billing,
        deliverables: delivery.deliverables,
        ...(continuation ? { continuation } : {}),
        approvals: currentApprovals.map((item) => ({
          id: item.id,
          toolSlug: item.toolSlug,
          reason: item.reason,
          status: item.status,
          expiresAt: item.expiresAt,
          stepId: typeof item.arguments.__stepId === "string" ? item.arguments.__stepId : undefined,
        })),
        finalText,
      });
    }

    // ──────────────────────────────────────────────────────────────────
    // Chemin universel historique (compatibilité : flux existants).
    // ──────────────────────────────────────────────────────────────────
    const universalAttachments = (body.attachments ?? []);
    await appendMessage({
      conversationId,
      userId: user.uid,
      role: "user",
      content: body.message,
      ...(attachmentsForMessage(body.attachments, { path: body.attachmentPath, name: body.attachmentName }) ? { attachments: attachmentsForMessage(body.attachments, { path: body.attachmentPath, name: body.attachmentName }) } : {}),
    });

    // VOIX-OFF DIRECTE (Task 114-a + fix capture 13:02) sur le chemin
    // universel aussi, AVANT l'intercept vidéo (la production vidéo reste
    // prioritaire sur sa propre demande) — suivi contextuel + clarification
    // déterministe inclus.
    const voiceOff = await interceptVoiceOff({
      userId: user.uid,
      conversationId,
      message: body.message,
      history: history.map((item) => ({ role: item.role, content: item.content })),
    });
    if (voiceOff?.kind === "clarify") {
      return NextResponse.json({
        mode: "chat",
        status: "completed",
        conversationId,
        objective: body.message,
        reply: voiceOff.reply,
      });
    }
    if (voiceOff) {
      return NextResponse.json({
        mode: "chat",
        status: "completed",
        conversationId,
        objective: body.message,
        reply: voiceOff.reply,
        audio: voiceOff.audio,
      });
    }

    // PRODUCTION VIDÉO (autopilote) sur le chemin universel aussi.
    if (looksLikeVideoRequest(body.message)) {
      try {
        const { createVideoProductionJob } = await import("@/lib/video/production-queue");
        const job = await createVideoProductionJob({
          userId: user.uid,
          // LIVRAISON CHAT (Task 114) : voir le commentaire du chemin agent.
          conversationId,
          prompt: body.message.trim().slice(0, 4000),
          title: extractVideoTitle(body.message),
        });
        const reply = [
          "Votre production vidéo est lancée. Enchaînement automatique : plan du réalisateur, scénario, visuels de scènes, narration, musique, montage et rendu final avec contrôle qualité.",
          `Le cadre de progression affiché ici suit la production RÉELLE en temps réel. Projet complet dans l'atelier vidéo : /studio/video/${job.projectId}`,
        ].join("\n");
        await appendMessage({ conversationId, userId: user.uid, role: "assistant", content: reply });
        return NextResponse.json({
          mode: "chat",
          status: "completed",
          conversationId,
          objective: body.message,
          reply,
          videoProject: { projectId: job.projectId, jobId: job.jobId },
        });
      } catch (videoError) {
        const unavailable = videoError instanceof Error && /n.est pas disponible/.test(videoError.message);
        const reply = unavailable
          ? "La production vidéo n'est pas disponible sur cette plateforme actuellement (moteur de production non configuré). Réessayez plus tard."
          : "Le lancement de la production vidéo a échoué. Réessayez dans un instant.";
        await appendMessage({ conversationId, userId: user.uid, role: "assistant", content: reply });
        return NextResponse.json({ mode: "chat", status: "completed", conversationId, objective: body.message, reply });
      }
    }

    // Génération d'images réelle (Agnes AI) sur le chemin universel aussi —
    // en NDJSON pour la progression RÉELLE.
    if (looksLikeImageRequest(body.message)) {
      return mediaProgressResponse(async (report) => {
        const imageResult = await respondWithImage({
          userId: user.uid,
          conversationId,
          message: body.message,
          onProgress: report,
        });
        return {
          mode: "chat",
          status: "completed",
          conversationId,
          objective: body.message,
          reply: imageResult.reply,
          imageUrl: imageResult.imageUrl,
        };
      });
    }

    // Connecteurs connectés : contexte injecté + composio.execute ouvert,
    // comme sur le chemin agent personnalisé.
    const connectedUniversal = await connectedPromise;
    // API personnelles de l'utilisateur : lecture réelle toujours possible,
    // écriture uniquement s'il en possède (validation humaine conservée).
    let hasUniversalCustomApis = false;
    try {
      const { listEnabledCustomApis } = await import("@/lib/integrations/custom-apis/repository");
      hasUniversalCustomApis = (await listEnabledCustomApis(user.uid, 12)).length > 0;
    } catch {
      hasUniversalCustomApis = false;
    }
    // Contexte conversationnel : le planificateur universel reçoit aussi les
    // échanges récents du fil (références implicites comprises).
    const universalHistoryNote = historyContextNote(history.map((item) => ({ role: item.role, content: item.content })));
    // Contenu RÉEL des pièces jointes : identique au chemin agent scopé.
    const universalAttachmentContexts = [
      ...(body.attachmentPath ? [{ path: body.attachmentPath, name: body.attachmentName ?? body.attachmentPath }] : []),
      ...universalAttachments,
    ];
    const universalAttachmentsNote = universalAttachmentContexts.length > 0
      ? await loadAgentAttachmentsContext(user.uid, universalAttachmentContexts).catch(() => ({ note: "", files: [] }))
      : { note: "", files: [] };
    const universalObjective = [
      universalAttachmentsNote.note,
      connectedUniversal.note,
      universalHistoryNote,
      body.message,
    ].filter(Boolean).join("\n\n");

    const plan = await planUniversalAgent(user.uid, universalObjective);
    // APPROBATION CONDITIONNELLE (identique au mode agent scopé) : une app
    // externe déjà connectée s'exécute directement, sans validation.
    const approvalSteps = await selectApprovalRequiredSteps(user.uid, plan.steps);

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

    // EXIGENCE PRODUCTION (chemin universel aussi) : la mission part sur la
    // file dès que possible — exécution serveur continue, onglet remplaçable.
    const universalQueued = await launchQueuedTaskMission({
      userId: user.uid,
      conversationId,
      objective: body.message,
      plan,
    });
    // ESCROW V2 : fonds insuffisants au lancement → 402 canonique, la mission
    // n'a PAS été créée. Message laissé sur le fil pour cohérence.
    if (universalQueued.escrowRejected) {
      const reply = "Solde insuffisant pour lancer cette mission. Rechargez votre portefeuille.";
      await appendMessage({ conversationId, userId: user.uid, role: "assistant", content: reply }).catch(() => undefined);
      return NextResponse.json({ error: reply, reason: "insufficient_funds" }, { status: 402 });
    }
    if (universalQueued.queued) {
      return NextResponse.json({
        mode: "agent",
        status: "queued",
        runId: universalQueued.runId,
        executionId: plan.executionId,
        conversationId,
        objective: body.message,
        plan,
        pollSeconds: 2,
      }, { status: 202 });
    }

    // Repli synchrone détaché du client (identique au chemin agent scopé).
    let universalSyncRunId: string | undefined;
    try {
      universalSyncRunId = await recordAgentRun({
        userId: user.uid,
        conversationId,
        plan,
        status: "running",
        outputs: {},
        observations: [],
        billing: { currency: "XAF", totalChargeMinor: 0, totalProviderCostEur: 0, llmInputTokens: 0, llmOutputTokens: 0 },
      });
    } catch (runError) {
      // Fail-soft (Task 96-c) : la valeur de retour reste neutre (undefined)
      // — le message final partira sans runId, la livraison elle-même est
      // indépendante de l'observabilité.
      logger.warn({ err: runError instanceof Error ? runError.message : runError }, "agent_chat_universal_run_not_recorded");
    }

    const runtime = new AgentRuntime({
      userId: user.uid,
      objective: body.message,
      plan,
      batchDeadlineMs: Date.now() + MISSION_SYNC_BUDGET_MS,
      policy: {
        ...buildPolicy(plan),
        allowedTools: [
          ...new Set([
            ...(buildPolicy(plan).allowedTools ?? []),
            ...(connectedUniversal.toolkits.length > 0 ? ["composio.execute"] : []),
            // API personnelles : lecture directe + écriture (validation humaine).
            ...(hasUniversalCustomApis ? ["custom_api.call", "custom_api.write"] : ["custom_api.call"]),
            // API directe par URL : lecture directe + écriture (validation humaine).
            "web.api",
            "web.api.write",
          ]),
        ],
        permissions: [
          ...new Set([
            ...buildPolicy(plan).permissions,
            ...(hasUniversalCustomApis ? ["tool.external" as const, "network.write" as const] : []),
          ]),
        ],
      },
    });

    let result;
    try {
      result = await runtime.run();
    } catch (error) {
      // ESCROW V2 : mission échue → le frais de résultat réservé est LIBÉRÉ
      // (fail-soft — l'échec visible reste inchangé).
      await captureMissionEscrow({ userId: user.uid, executionId: plan.executionId, missionStatus: "failed" }).catch(() => undefined);
      return NextResponse.json({
        mode: "agent",
        status: "failed",
        executionId: plan.executionId,
        conversationId,
        objective: body.message,
        plan,
        error: error instanceof Error ? error.message : "Agent execution failed.",
        resumable: true,
        approvals: await listActionApprovals(user.uid, plan.executionId),
      }, { status: errorStatus(error, 400) });
    }

    // Métriques OTel (Task 59) : chemin universel sans agent — exécution
    // personnelle (pas d'orgId), coût/tokens toujours enregistrés.
    recordExecutionMetrics({
      executionId: plan.executionId,
      status: result.status,
      userId: user.uid,
      chargeMinor: result.billing.totalChargeMinor,
      providerCostEur: result.billing.totalProviderCostEur,
      inputTokens: result.billing.llmInputTokens,
      outputTokens: result.billing.llmOutputTokens,
    });

    const currentApprovals = await listActionApprovals(user.uid, plan.executionId);
    const pending = currentApprovals.filter((item) => item.status === "pending");

    const status = pending.length > 0 ? "waiting_approval" : result.status;

    // LIVRAISON UNIFIÉE (run réconcilié + message + livrables réels).
    const universalDelivery = await deliverMissionToConversation({
      userId: user.uid,
      conversationId,
      state: result,
      ...(universalSyncRunId ? { runId: universalSyncRunId } : {}),
    }).catch(() => ({ finalText: undefined as string | undefined, deliverables: [], messageId: undefined }));

    // ESCROW V2 : capture (réussite) / libération (échec/annulation) du
    // frais de résultat — statut terminal uniquement (décision interne),
    // idempotent et fail-soft (jamais bloquant pour la réponse).
    await captureMissionEscrow({ userId: user.uid, executionId: result.executionId, missionStatus: result.status });

    // Continuation arrière-plan si l'échéance de tranche a coupé la mission.
    let universalContinuation: { queued: boolean; runId?: string; reason?: string } | undefined;
    if (result.status === "paused" && result.plan.steps.some((step) => step.status === "pending")) {
      universalContinuation = await enqueueMissionContinuation({
        userId: user.uid,
        executionId: result.executionId,
        objective: result.objective || body.message,
        plan: result.plan,
        conversationId,
      });
    }
    const finalText = universalDelivery.finalText;

    return NextResponse.json({
      mode: "agent",
      status,
      ...(universalSyncRunId ? { runId: universalSyncRunId } : {}),
      executionId: result.executionId,
      conversationId,
      objective: result.objective,
      plan: result.plan,
      observations: result.observations,
      outputs: result.outputs,
      billing: result.billing,
      deliverables: universalDelivery.deliverables,
      ...(universalContinuation ? { continuation: universalContinuation } : {}),
      approvals: currentApprovals.map((item) => ({
        id: item.id,
        toolSlug: item.toolSlug,
        reason: item.reason,
        status: item.status,
        expiresAt: item.expiresAt,
        stepId: typeof item.arguments.__stepId === "string" ? item.arguments.__stepId : undefined,
      })),
      finalText,
    });
  } catch (error) {
    // Erreur structurée : un code machine (PROVIDER_UNAVAILABLE, INTERNAL…)
    // permet à l'UI d'afficher l'état réel (réessayer vs réconnecter) au lieu
    // de deviner à partir du message.
    const body = errorBody(error, "Agent request failed.");
    // Session absente/expirée : 401 explicite (l'UI propose la reconnexion
    // au lieu d'un « réessayez » sans fin).
    if (body.code === "AUTH_REQUIRED") {
      return NextResponse.json({ error: body.error, code: body.code }, { status: 401 });
    }
    // Fournisseur IA / planificateur : 502 avec le message d'origine
    // (comportement historique inchangé).
    const upstream =
      body.error.includes("provider")
      || body.error.includes("planner")
      || body.error.includes("plan généré");
    // Persistance indisponible (Task 96-c : quota Firestore épuisé, disjoncteur
    // ouvert, incident Firestore dégradé) : 503 actionnable — une panne de
    // stockage ne doit JAMAIS ressembler à un simple échec de mission (400)
    // ni masquer l'état réel derrière « Impossible de lancer ».
    if (isFirestoreQuotaError(error) || (body.code === "PROVIDER_UNAVAILABLE" && !upstream)) {
      return NextResponse.json(
        {
          error: "Persistance momentanément indisponible (quota de base de données atteint). Réessaie dans quelques instants — la reprise est automatique.",
          code: "PROVIDER_UNAVAILABLE",
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: upstream ? body.error : "Impossible de lancer la mission pour le moment. Réessayez.", code: body.code },
      { status: upstream ? 502 : 400 },
    );
  }
}

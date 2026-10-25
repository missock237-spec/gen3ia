import "server-only";

/**
 * Tour conversationnel « chat » (réponse directe, streaming, vision) et compétence image partagée (génération réelle + persistance R2). Extrait de engine.ts — code déplacé tel quel.
 */

import { buildContextWindow, estimateTokens } from "./context-window";
import { buildFollowUpSuggestions } from "./follow-ups";
import { safeEmitter } from "./stream-events";
import type { ConversationStreamEvent } from "./stream-events";
import type { ConversationMessage } from "./types";
import { detectImageRatio, enhanceImagePrompt, extractImagePrompt } from "@/lib/ai/image-intent";
import { languageDirective } from "@/lib/ai/prompt-enhancer";
import { RESPONSE_FORMAT_RULES, preferFreeForVisibleAnswers } from "@/lib/ai/response-quality";
import { generate, generateStream } from "@/lib/ai/router";
import { ThinkTagStreamFilter, stripThinkTags } from "@/lib/ai/think-filter";
import { imagesForModel } from "@/lib/ai/vision-input";
import { appendMessage } from "@/lib/chat/repository";
import type { ChatConversation, ChatMessage } from "@/lib/chat/repository";
import { shouldSummarize, summarizeChatConversation } from "@/lib/memory/episodic";
import type { WorkspaceProject } from "@/lib/domain/projects/repository";
import { attachmentImageCandidates } from "@/lib/files/image-source";
import type { TurnIntent } from "./engine-intent";
import { CHAT_BUDGET_MS, CONTEXT_WINDOW_BUDGET_TOKENS, historyForModel, withTimeout } from "./engine-turn";
import type { AgentTurnContext, ConversationTurnInput, ConversationTurnResult } from "./engine-turn";

/* ------------------------------------------------------------------ */
/* Tour « chat » — réponse directe                                     */
/* ------------------------------------------------------------------ */

export interface TurnBase extends ConversationTurnInput {
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

export interface TurnContext extends TurnBase {
  intent: TurnIntent;
}

/**
 * Normalise la télémétrie brute du moteur (AIResponse.raw — forme « unknown »
 * par contrat) en payload d'événement turn_telemetry pour le panneau debug.
 * Retourne null si la réponse ne transporte pas de télémétrie langage
 * (ne doit JAMAIS bloquer le tour).
 */
function construireTelemetrie(
  response: { raw?: unknown; latencyMs?: number } | undefined,
): Extract<ConversationStreamEvent, { type: "turn_telemetry" }> | null {
  try {
    const raw = (response?.raw ?? null) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || !("langage" in raw)) return null;
    const langage = (raw.langage ?? {}) as Record<string, unknown>;
    const resonances: Record<string, number> = {};
    for (const [canal, valeur] of Object.entries(
      (raw.resonances ?? {}) as Record<string, unknown>,
    )) {
      if (typeof valeur === "number") resonances[canal] = valeur;
    }
    return {
      type: "turn_telemetry",
      raw: {
        moteur: typeof raw.moteur === "string" ? raw.moteur : "snn",
        intention: typeof raw.intention === "string" ? raw.intention : "inconnue",
        scoreResonance: typeof raw.scoreResonance === "number" ? raw.scoreResonance : 0,
        resonances,
        motsCles: Array.isArray(raw.motsCles)
          ? (raw.motsCles as unknown[]).filter((m): m is string => typeof m === "string").slice(0, 8)
          : [],
        langage: {
          source: typeof langage.source === "string" ? langage.source : "inconnue",
          theme: typeof langage.theme === "string" ? langage.theme : null,
          scoreAppariement:
            typeof langage.scoreAppariement === "number" ? langage.scoreAppariement : null,
          cle: typeof langage.cle === "string" ? langage.cle : null,
          cache: langage.cache === "hit" || langage.cache === "miss" ? langage.cache : null,
        },
        latenceMs: typeof response?.latencyMs === "number" ? response.latencyMs : null,
      },
    };
  } catch {
    return null;
  }
}

export async function runChatTurn(ctx: TurnContext): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  const streaming = Boolean(ctx.onEvent);
  // Task 141 — agent dédié : quand l'utilisateur a choisi un agent dans le
  // composer, la charte de CET agent prime sur l'identité universelle (nom,
  // mission, compétences, persona, garde-fous) — les règles de plateforme
  // (formats, médias, honnêteté) restent inchangées et prévalent en dernier.
  const identityPart = ctx.agent
    ? `Tu réponds actuellement sous l'identité de l'agent dédié « ${ctx.agent.name} ». La charte de cet agent prime sur ton identité par défaut — respecte son ton, son périmètre et ses garde-fous tout en gardant toutes tes capacités d'exécution :\n\n${ctx.agent.charter}`
    : "Tu es l'assistant de conversation Gen3ia, propulsé par le moteur neuronal Gen3 : tu réponds de façon directe, structurée et actionnable, et tu ne prétends jamais tenir des capacités que tu n'as pas.";
  const systemParts = [
    identityPart,
    // Task 52 : contrat de présentation visible (clarté, précision selon le
    // sujet saisi, structure markdown, zéro invention) — aligné sur l'exigence
    // « qualité ChatGPT à chaque requête ».
    RESPONSE_FORMAT_RULES,
    // Compréhension exacte : répondre dans la LANGUE du dernier message.
    languageDirective(ctx.message),
    "La génération d'IMAGES, la production de VIDÉOS, la synthèse d'AUDIOS (moteur audio neural local — composition sonore, pas de parole naturelle) et l'analyse de médias (mesures réelles : format, dimensions, durée, codecs, palette) sont effectuées par la plateforme Gen3ia, jamais par toi dans cette réponse : ne prétends JAMAIS avoir généré un média comme s'il était affiché, et n'invente jamais d'URL.",
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
            knowledgeContext: ctx.knowledgeContext,
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
      const telemetrie = construireTelemetrie(response);
      if (telemetrie) await onEvent(telemetrie);
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
              knowledgeContext: ctx.knowledgeContext,
              metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
            }),
            CHAT_BUDGET_MS,
            "réponse conversationnelle",
          );
          content = stripThinkTags(response.text);
          provider = response.provider;
          model = response.model;
          usage = response.usage;
          const telemetrieRepli = construireTelemetrie(response);
          if (telemetrieRepli) await onEvent(telemetrieRepli);
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
          knowledgeContext: ctx.knowledgeContext,
          metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
        }),
        CHAT_BUDGET_MS,
        "réponse conversationnelle",
      );
      content = stripThinkTags(response.text);
      provider = response.provider;
      model = response.model;
      usage = response.usage;
      const telemetrieNonFlux = construireTelemetrie(response);
      if (telemetrieNonFlux) await onEvent(telemetrieNonFlux);
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

  // RÉSUMÉ ÉPISODIQUE (fire-and-forget, jamais bloquant) : tous les 8 messages
  // d'une conversation, un résumé compact est généré et archivé comme souvenir
  // « decision » lié à la conversation — cohérence long terme sans saturer le
  // SNN, rappelable par la recherche sémantique.
  try {
    const nbMessages = ctx.priorHistory.length + 2;
    if (shouldSummarize(nbMessages)) {
      void summarizeChatConversation({
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        history: [
          ...ctx.priorHistory.slice(-23).map((message) => ({
            role: message.role as "user" | "assistant",
            content: message.content,
          })),
          { role: "user", content: ctx.message },
          { role: "assistant", content },
        ],
      });
    }
  } catch {
    // Le résumé est un gain, jamais une dépendance.
  }

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
export async function produceConversationImage(
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
export function findLastConversationImage(history: ChatMessage[]): string | null {
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

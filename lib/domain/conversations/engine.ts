import "server-only";

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

import { detectAgentIntent } from "./agent-intents";
import { detectAppCreationIntent, detectChartIntent } from "./artefact-apps";
import { detectScheduleIntent, detectServiceControlIntent, detectWorkflowIntent } from "./service-intents";
import { safeEmitter } from "./stream-events";
import { assessComplexity, buildEvolutionContext, buildRunHistoryContext } from "@/lib/ai/auto-improvement";
import { detectAmbiguitySignals, deterministicClarifyingQuestion, markClarification, resolveClarifiedObjective } from "@/lib/ai/clarification-followup";
import { looksLikeExplicitDrawingRequest, looksLikeImageRequest } from "@/lib/ai/image-intent";
import { enhancePromptForExecution, languageDirective } from "@/lib/ai/prompt-enhancer";
import { looksLikeVideoRequest } from "@/lib/ai/video-intent";
import { appendMessage, getConversation, listMessages } from "@/lib/chat/repository";
import type { ChatConversation } from "@/lib/chat/repository";
import { hasImageAttachment, shouldRouteImageEdit } from "@/lib/domain/conversations/image-intent";
import { loadWebPageContext } from "@/lib/domain/conversations/web-context";
import { getProject } from "@/lib/domain/projects/repository";
import { runAIJSON } from "@/lib/engines/ai-engine";
import { loadImportedFilesContext } from "@/lib/files/import";
import { detectApiProvisioning, extractApiPathFromMessage, extractApiUsageName } from "@/lib/integrations/custom-apis/detect";
import { listEnabledCustomApis } from "@/lib/integrations/custom-apis/repository";
import type { CustomApiRecord } from "@/lib/integrations/custom-apis/repository";
import { describeServersForPrompt } from "@/lib/integrations/mcp/service";
import { buildKnowledgeContext, shouldSearchKnowledge } from "@/lib/knowledge/chat-context";
import { resolveKnowledgeScope, searchKnowledge } from "@/lib/knowledge/search";
import { construireContexteAnalyseMedias } from "@/lib/media/analyze";
import { runApiProvisioningTurn, runAppTurn, runChartTurn } from "./engine-apps";
import { findLastConversationImage, runChatTurn } from "./engine-chat";
import type { TurnBase } from "./engine-chat";
import { IntentSchema, buildIntentSystemPrompt, detectExplicitToolIntent, extractApiUrlFromMessage, extractSearchQuery } from "./engine-intent";
import type { ExplicitToolIntent, TurnIntent } from "./engine-intent";
import { runImageEditTurn, runImageTurn, runVideoTurn } from "./engine-media";
// ENTRAÎNEMENT DEPUIS LE CHAT — entrée UNIQUE (demande utilisateur) : les
// messages « apprends que / retiens que / entraîne-toi » entraînent
// réellement le cortex via l'outil brain.train.
import { estIntentionEntrainement, runTrainingTurn } from "./engine-training";
import { runPlanTurn } from "./engine-plan";
import { runAgentIntentTurn, runScheduleIntentTurn, runServiceControlTurn, runWorkflowIntentTurn } from "./engine-services";
import { conversationToolCatalog } from "./engine-tools";
import { INTENT_BUDGET_MS, attachmentsContext, loadTurnAgent, withTimeout } from "./engine-turn";
import type { ConversationTurnInput, ConversationTurnResult } from "./engine-turn";
import { runAI } from "@/lib/engines/ai-engine";

/* ------------------------------------------------------------------ */
/* Surface publique — préservée à l'identique (réexports des modules).   */
/* Aucun importeur du moteur ne change.                                  */
/* ------------------------------------------------------------------ */

export {
  conversationToolCatalog,
  CONVERSATION_EXECUTION_POLICY,
  stepRequiresApproval,
  estimatedCostForTool,
  dataScopeForTool,
  condenseToolOutput,
} from "./engine-tools";
export type { ToolCatalogEntry } from "./engine-tools";
export {
  extractEmailSubject,
  extractEmailText,
  detectExplicitToolIntent,
  extractDocumentTitle,
  extractDocumentFormat,
  extractApiUrlFromMessage,
  looksLikeDirectApiCall,
  detectApiWriteIntent,
  extractSearchQuery,
  buildIntentSystemPrompt,
} from "./engine-intent";
export type { TurnIntent, ExplicitToolIntent, IntentPromptMeta } from "./engine-intent";
export type { ConversationTurnInput, AgentTurnContext, ConversationTurnResult } from "./engine-turn";
export { planFailureAppendix, inferArtifactType } from "./engine-plan";
export { executeApprovedStep, rejectApprovalStep } from "./engine-approvals";
export type { ApprovedStepOutcome } from "./engine-approvals";
export { runAI as conversationRunAI };

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
  // 1 bis-3) Agents sous commande de l'IA : créer, lister, activer,
  // désactiver ou supprimer un agent RÉELLEMENT depuis le langage naturel
  // (même détecteur déterministe, mêmes services que le Studio — aucune
  // invention : l'agent créé reprend exactement la demande énoncée).
  const agentIntent = detectAgentIntent(input.message);
  if (agentIntent) {
    const result = await runAgentIntentTurn(baseCtx, agentIntent);
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

  // 1 septies) Analyse RÉELLE des médias joints (image/audio/vidéo) :
  // moteur LOCAL (audit multimodal) — sharp (dimensions, palette, luminosité,
  // contraste), ffprobe + volumedetect (durée, codecs, dynamique), extraction
  // d'images clés pour la vidéo. « analyse cette vidéo / cet audio / cette
  // photo » reçoit enfin des MESURES réelles injectées au tour. Fail-soft
  // TOTAL (jamais bloquant), plafonné à 2 médias ; les images restent aussi
  // sur la voie vision native (imagesForModel). Aucune perception inventée :
  // la transcription vocale parlée n'est pas incluse et le contexte le dit.
  const mediaAnalysisContext = await construireContexteAnalyseMedias({
    userId: input.userId,
    attachments: input.attachments,
  }).catch((erreur) => {
    console.warn(
      "[conversation] analyse média locale indisponible (fail-soft) :",
      erreur instanceof Error ? erreur.message : String(erreur),
    );
    return "";
  });

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
  // 2 bis) ENTRAÎNEMENT DEPUIS LE CHAT (entrée unique) : « apprends que… »,
  // « retiens que… », « entraîne-toi sur… » → apprentissage RÉEL du cortex
  // langagier (outil brain.train) + réponse honnête avec compteurs. Priorité
  // sur les autres tours : enseigner est une intention explicite.
  if (estIntentionEntrainement(input.message)) {
    await onEvent({ type: "status", phase: "execution", label: "Entraînement du cerveau en cours…" });
    const result = await runTrainingTurn({ ...input, conversation, project, projectId, userMessage, priorHistory });
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
    // Bouton « Recherche web » activé : la recherche est DEMANDÉE par l'utilisateur
    // (option explicite du composer) — elle prime sur la détection heuristique.
    const explicit = input.webSearch
      ? ({ toolName: "web.search", query: extractSearchQuery(input.message) || input.message.trim().slice(0, 300) } as ExplicitToolIntent)
      : detectExplicitToolIntent(input.message, catalog, customApis);
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
  if (intent.mode === "plan" && input.webSearch && !(intent.steps ?? []).some((s) => s.toolName === "web.search")) {
    // Recherche web activée depuis le composer : le plan reçoit TOUJOURS une
    // étape de recherche RÉELLE en tête — le bouton ne peut pas être ignoré
    // par la classification (déterministe, aucune variance LLM).
    intent = {
      ...intent,
      steps: [
        {
          title: "Recherche web",
          detail: "Recherche réelle sur le web activée par l'utilisateur (bouton Recherche web du composer).",
          toolName: "web.search",
          toolInput: { query: extractSearchQuery(input.message) || input.message.trim().slice(0, 300), maxResults: 8 },
        },
        ...(intent.steps ?? []),
      ].slice(0, 8),
    };
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

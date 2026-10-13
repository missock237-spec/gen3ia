import { generate } from "../ai/router";
import { stripThinkTags } from "../ai/think-filter";
import { preferFreeForUnderstanding, preferFreeForVisibleAnswers, RESPONSE_FORMAT_RULES } from "../ai/response-quality";
import { REASONING_DIRECTIVE, composeStructuredPrompt } from "../ai/prompt-composer";
import { buildFewShotSection } from "../ai/few-shot";
import { reviewVisibleAnswer } from "../ai/self-review";
import type { AIImageAttachment, AIProvider } from "../ai/models";
import { assembleMessages } from "../ai/context-window";
import { applyPromptVariables, type PromptVariableContext } from "../ai/prompt-template";
import { buildTruthContext, formatTruthContext, cleanRequestedResult } from "../ai/truth-context";
import { detectAmbiguitySignals, deterministicClarifyingQuestion } from "../ai/clarification-followup";
import { planUniversalAgent } from "./runtime/unified-agent";
import type { RuntimePlan } from "./runtime/types";
import { policyForAgent } from "./personalized-plan";
import { buildAgentCharter, labelForAgent } from "./charter";
import { getAgentForUser } from "./repository";
import { twinDirectiveForUser } from "../identity/twin";
import type { AgentRecord } from "./schema";

/**
 * Moteur de conversation d'un agent IA personnalisé du Studio.
 *
 * Chaque requête utilisateur passe par TROIS décisions distinctes :
 *  1. classification — la demande nécessite-t-elle une réponse claire et
 *     simple (mode "chat", comme un LLM) ou une exécution concrète de la
 *     tâche pour laquelle l'agent a été créé (mode "task", comme un
 *     professionnel qui agit) ?
 *  2. périmètre — la demande relève-t-elle du domaine de l'agent ? Sinon,
 *     refus professionnel sans jamais sortir du cadre.
 *  3. exécution — en mode "task", le plan est construit avec la charte de
 *     l'agent et restreint aux outils autorisés par son niveau de sécurité.
 */

export type ChatRequestMode = "chat" | "task";

/** Niveau d'ambiguïté de la demande (jugement du classificateur). */
export type RequestAmbiguity = "none" | "low" | "high";

export interface RequestClassification {
  mode: ChatRequestMode;
  inScope: boolean;
  reason: string;
  /**
   * Confiance du classificateur dans sa compréhension de la demande
   * (0.0..1.0). Task 135 : sous CONFIDENCE_THRESHOLD en mode "task", une
   * question de clarification est posée AVANT d'exécuter — mieux vaut
   * demander que mal exécuter.
   */
  confidence?: number;
  /** Ambiguïté perçue (« high » force une clarification). */
  ambiguity?: RequestAmbiguity;
  /**
   * Question de clarification (français, max 1) : proposée par le
   * classificateur quand la compréhension de la demande n'est pas
   * certaine (ambiguïté réelle entre deux actions matériellement
   * différentes, référent implicite, demande trop courte) ET qu'aucun
   * choix par défaut raisonnable n'existe.
   */
  clarifyingQuestion?: string;
  /** Options de réponse rapides (max 3) proposées à l'utilisateur. */
  suggestions?: string[];
}

/** Seuil de confiance sous lequel une clarification est exigée (Task 135). */
export const CLARIFICATION_CONFIDENCE_THRESHOLD = 0.55;

const CLASSIFIER_SYSTEM = [
  "Tu es le classificateur de requêtes des agents IA Gen3ia.",
  "On te donne la charte d'un agent (son domaine, ses compétences), les derniers échanges de la conversation (pour résoudre les références implicites : pronoms, « ce fichier », « la même chose ») et le message d'un utilisateur.",
  "Analyse D'ABORD les échanges passés pour comprendre le VRAI besoin de l'utilisateur, puis décide, en comparant la charte et ce besoin :",
  "1. mode: \"chat\" si le besoin appelle une réponse claire et simple (salutation, question, explication, conseil, reformulation, discussion) — l'agent répond directement comme un LLM ;",
  "mode: \"task\" si le besoin demande de RÉALISER quelque chose de concret dans le domaine de l'agent (produire un livrable, exécuter, créer, rechercher des données, préparer un document) — l'agent agit alors comme un professionnel qui exécute la tâche pour laquelle il a été créé.",
  "2. RÈGLES DE PÉRIMÈTRE (inScope) :",
  "   - TOUJOURS inScope: true pour les échanges conversationnels : questions sur la conversation elle-même (ce qui a été dit, qui est l'utilisateur, rappeler un détail déjà évoqué), politesses, questions sur l'agent, tout ce qui mobilise la mémoire du fil.",
  "   - TOUJOURS inScope: true pour une demande de génération d'image ou de visuel (image, photo, logo, illustration, affiche) : c'est une capacité native de l'agent Gen3ia, ne la bloque JAMAIS, même si le sujet demandé n'est pas métier.",
  "   - Les agents Gen3ia sont POLYVALENTS : une demande hors de la spécialité principale de l'agent n'est JAMAIS hors périmètre pour autant — inScope: true dès que le besoin peut être servi par une réponse LLM de qualité ou par les outils, connecteurs et services disponibles.",
  "   - inScope: false UNIQUEMENT si la demande est matériellement impossible à servir même avec les outils, connecteurs et services disponibles (exemple : passer un appel téléphonique alors qu'aucun connecteur de téléphonie n'est disponible). En cas de doute, inScope: true.",
  "3. reason: une courte justification en français.",
  "4. confidence: ta confiance dans ta compréhension EXACTE de la demande, entre 0.0 et 1.0 (1.0 = demande parfaitement claire et non équivoque ; 0.5 = interprétation plausible mais incertaine ; 0.0 = incompréhension totale).",
  "5. ambiguity: \"none\" (demande claire), \"low\" (légère hésitation sans conséquence sur l'action), \"high\" (la demande peut vouloir dire des choses matériellement différentes).",
  "6. clarifyingQuestion (OPTIONNEL, en français) : UNE question de clarification à poser à l'utilisateur POUR TE RASSURER avant d'agir. Pose-la quand : (a) la demande est ambiguë entre deux actions matériellement différentes (exemple : « prépare le lancement » = rédiger un plan ? envoyer une campagne ? créer une page ?) ET qu'aucun choix par défaut raisonnable n'existe ; (b) un référent est implicite et non résolvable par l'historique (« fais-le », « la même chose », « continue ») ; (c) une action coûteuse ou irréversible serait exécutée sur une compréhension incertaine (confidence < 0.55 ou ambiguity high). Mieux vaut DEMANDER que mal exécuter. Néanmoins, ne pose JAMAIS de question pour une salutation, une simple question, ou une demande déjà claire — et si l'historique lève l'ambiguïté, agis.",
  "7. suggestions: OPTIONNEL, 1 à 3 réponses courtes (chacune ≤ 60 caractères) que l'utilisateur pourrait cliquer pour répondre à ta clarifyingQuestion (ex : [\"Rédiger le plan\", \"Envoyer la campagne\"]). Uniquement si clarifyingQuestion est présent.",
  "Réponds STRICTEMENT en JSON : {\"mode\":\"chat|task\",\"inScope\":true|false,\"reason\":\"...\",\"confidence\":0.0,\"ambiguity\":\"none|low|high\",\"clarifyingQuestion\":\"... (optionnel)\",\"suggestions\":[\"...\"] (optionnel)}",
].join(" ");

/**
 * Marqueurs interrogatifs FR + EN (détection INDÉPENDANTE DE LA LANGUE) :
 * l'ancienne liste était exclusivement française — une question anglaise de
 * 500 caractères était classée « mission ».
 */
const QUESTION_STARTER_RE =
  /^(?:bonjour|salut|bonsoir|hello|coucou|merci|qui es[- ]tu|tu es|c['’]est quoi|qu['’]est-ce|qu['’]est ce|comment|pourquoi|quel(?:le|s)?|quoi|que|qui|où|quand|combien|peux-tu|pourrais-tu|pouvez-vous|est-ce que|explique(?:-moi)?|parle-moi|what|why|how|who|where|when|which|can you|could you|tell me|do you|are you|is there)\b/i;

/**
 * Verbes d'action EXPLICITES (FR + EN) : ils forcent le mode task, même
 * quand la demande est formulée poliment (« Peux-tu créer un site ? ») ou
 * se termine par un « ? » — poser une question POLIE ne change pas la nature
 * d'une demande d'exécution.
 */
const EXPLICIT_ACTION_VERB_RE =
  /\b(cr[ée]e(?:r|z)?|g[éeè]n[éeè]re(?:r|z)?|r[ée]dige(?:r|z)?|analys[ée](?:r|z)?|envoi(?:e|er|ez)|envoy(?:e|er|ez)|exp[ée]di(?:e|er)|ex[ée]cute(?:r|z)?|construis(?:re)?|programme(?:r)?|publi(?:e|er|ez)|pr[ée]par(?:e|er|ez)|t[ée]l[ée]charge(?:r|z)?|convertis?(?:r)?|impl[ée]mente(?:r|z)?|corrige(?:r|z)?|d[ée]ploy(?:e|er|ez)|liste(?:r|-moi)?|trouve(?:r|-moi)?|cherche(?:r|-moi)?|supprim(?:e|er|ez)|modifi(?:e|er|ez)|automatis(?:e|er)|planifi(?:e|er|ez)|r[ée]serv(?:e|er)|create|generate|send|build|write|make|produce|deploy|implement|fix|convert|publish|prepare|analyze|download|upload|delete|remove|update|schedule|automate|run|execute|search|find|summarize|translate|export)\b/i;

/**
 * Repli déterministe quand le classificateur LLM est indisponible :
 * les messages interrogatifs (LANGUE-AGNOSTIQUE : « ? » dans les 200 derniers
 * caractères OU marqueur interrogatif FR+EN) sans verbe d'action obtiennent
 * une réponse directe, tout le reste suit le comportement d'exécution
 * historique. Plafond de longueur relevé à 1200 caractères : une LONGUE
 * question française reste une question (l'ancien plafond de 400 la
 * transformait en mission).
 */
export function heuristicClassification(message: string): RequestClassification {
  const text = message.trim();
  const lower = text.toLowerCase();
  const isQuestion = text.slice(-200).includes("?") || QUESTION_STARTER_RE.test(lower);
  // Les verbes d'action EXPLICITES forcent le mode task, même formulés
  // poliment ou avec un « ? » final.
  const hasActionVerb = EXPLICIT_ACTION_VERB_RE.test(lower);
  const shortConversational = lower.length <= 1200 && !hasActionVerb;
  const mode: ChatRequestMode = isQuestion && shortConversational ? "chat" : "task";
  // Task 135 — repli avec AMBIGUÏTÉ DÉTERMINISTE : si les signaux
  // d'ambiguïté (référent implicite, demande trop courte) sont présents en
  // mode task, le repli propose DÉJÀ la question (aucun LLM requis).
  const signals = detectAmbiguitySignals(text);
  const question = mode === "task" ? deterministicClarifyingQuestion(signals, text) : null;
  return {
    mode,
    inScope: true,
    reason: "Classification heuristique (classificateur IA indisponible).",
    ...(question ? { clarifyingQuestion: question, confidence: 0.4, ambiguity: "high" as const } : {}),
  };
}

function normalizeMode(value: unknown): ChatRequestMode | null {
  return value === "chat" || value === "task" ? value : null;
}

export async function classifyRequest(
  agent: Pick<AgentRecord, "name" | "description" | "type" | "typeLabel" | "skills">,
  message: string,
  history: ChatHistoryMessage[] = [],
  /** Contexte préalable (pièces jointes réelles, mémoire…) : le
   *  classificateur décide en voyant le MÊME contexte que la réponse. */
  contextNote?: string,
): Promise<RequestClassification> {
  const charter = buildAgentCharter(agent);
  try {
    const recentHistory = history.slice(-8).map((item) => ({ role: item.role, content: item.content.slice(0, 600) }));
    const response = await generate({
      task: "agent",
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM },
        { role: "user", content: JSON.stringify({ charte: charter, ...(recentHistory.length > 0 ? { derniersEchanges: recentHistory } : {}), ...(contextNote ? { contexteReel: contextNote } : {}), message }) },
      ],
      requiresStructuredOutput: true,
      // Tâche de COMPRÉHENSION qui conditionne la qualité de la réponse
      // finale : routage par la politique de qualité (gratuit forcé
      // uniquement en mode free explicite — plus de gratuit systématique).
      preferFree: preferFreeForUnderstanding(),
      maxTokens: 500,
      metadata: { purpose: "agent-chat-classification" },
    });

    const text = response.text.trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    let parsed: unknown = null;
    for (const candidate of [fenced?.[1]?.trim(), text]) {
      if (!candidate) continue;
      try {
        parsed = JSON.parse(candidate);
        break;
      } catch {
        const start = candidate.indexOf("{");
        const end = candidate.lastIndexOf("}");
        if (start >= 0 && end > start) {
          try { parsed = JSON.parse(candidate.slice(start, end + 1)); break; } catch { /* candidat suivant */ }
        }
      }
    }

    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const mode = normalizeMode(record.mode);
      if (mode) {
        const confidenceRaw = Number(record.confidence);
        const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : undefined;
        const ambiguity = record.ambiguity === "high" || record.ambiguity === "low" || record.ambiguity === "none" ? record.ambiguity : undefined;
        const suggestions = Array.isArray(record.suggestions)
          ? record.suggestions.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 3).map((s) => s.trim().slice(0, 60))
          : undefined;
        return {
          mode,
          inScope: record.inScope !== false,
          reason: typeof record.reason === "string" ? record.reason.slice(0, 300) : "",
          ...(confidence !== undefined ? { confidence } : {}),
          ...(ambiguity ? { ambiguity } : {}),
          ...(typeof record.clarifyingQuestion === "string" && record.clarifyingQuestion.trim()
            ? { clarifyingQuestion: record.clarifyingQuestion.trim().slice(0, 500) }
            : {}),
          ...(suggestions && suggestions.length > 0 ? { suggestions } : {}),
        };
      }
    }
    // Anomalie A3 (Task 45) : le repli n'est plus silencieux — observable
    // dans les logs pour distinguer une panne du classificateur d'un choix.
    console.warn("[agent-chat] classificateur: réponse non exploitable, repli heuristique", { reason: typeof parsed === "object" ? (parsed as Record<string, unknown>).mode : parsed });
    return heuristicClassification(message);
  } catch (error) {
    console.warn("[agent-chat] classificateur indisponible, repli heuristique", error instanceof Error ? error.message : error);
    return heuristicClassification(message);
  }
}

export type ChatHistoryMessage = { role: "user" | "assistant"; content: string };

/**
 * Note de contexte construite depuis l'historique de la conversation :
 * permet au planificateur (mode "task") de comprendre les références
 * implicites et de s'appuyer sur les échanges passés. Fonction pure.
 */
export function historyContextNote(history: ChatHistoryMessage[], limit = 8): string | undefined {
  const recent = history.slice(-limit);
  if (recent.length === 0) return undefined;
  const lines = recent.map((item) => `- ${item.role === "user" ? "Utilisateur" : "Assistant"} : ${item.content.replace(/\s+/g, " ").slice(0, 500)}`);
  return [
    "[Contexte de la conversation — échanges précédents. Utilise-les pour résoudre les références implicites et comprendre le VRAI besoin de l'utilisateur :]",
    ...lines,
  ].join("\n");
}

/**
 * Réponse directe (mode "chat") : la charte de l'agent pilote un appel LLM
 * classique. La charte impose un ton professionnel, la polyvalence et
 * l'honnêteté de capacité — ce mode est utilisé après la classification.
 */
export async function answerAsAgent(
  userId: string,
  agent: Pick<AgentRecord, "name" | "description" | "type" | "typeLabel" | "skills" | "agentMode" | "memoryFile" | "preferredModel">,
  history: ChatHistoryMessage[],
  message: string,
  contextNote?: string,
  promptContext?: PromptVariableContext,
  /** VISION : images réellement jointes au message (parts vision
   *  consommées par les providers — voir lib/ai/vision-input.ts). */
  images?: AIImageAttachment[],
): Promise<string> {
  // Prompts système avancés : les jetons {{date}}, {{time}}, {{user.name}},
  // {{agent.name}}… de la charte sont résolus avec l'état RÉEL de la
  // requête (jamais de placeholder qui fuit dans le prompt).
  const charter = applyPromptVariables(buildAgentCharter(agent), {
    agentName: agent.name,
    agentType: agent.type,
    agentTypeLabel: agent.typeLabel,
    ...promptContext,
  }).text;
  // Task 114-b — Jumeau créatif : la signature créative de l'UTILISATEUR
  // (style d'écriture, univers, valeurs, ton) complète la charte dans le
  // prompt système. Fail-soft total : une panne identité/R2 n'interrompt
  // JAMAIS un chat (twinDirectiveForUser ne lève pas, garde en profondeur).
  let charterAvecJumeau = charter;
  try {
    const jumeau = await twinDirectiveForUser(userId);
    if (jumeau) charterAvecJumeau = `${charter}\n\n${jumeau}`;
  } catch (error) {
    console.warn("[agent-chat] directive du jumeau indisponible, chat sans jumeau :", error instanceof Error ? error.message : error);
  }
  const truth = await buildTruthContext(userId, message, history);
  const grounding = formatTruthContext(truth);
  const userContent = `${grounding}${contextNote ? `\n\n${contextNote}` : ""}\n\nDEMANDE ACTUELLE :\n${message}`;
  // Task 138 — INGÉNIERIE DE PROMPT STRUCTURÉE : le prompt système suit
  // désormais le squelette normalisé RÔLE → MÉTHODE (raisonnement par
  // étapes) → CONTRAINTES → FORMAT → EXEMPLES, au lieu d'un empilement
  // ad-hoc. La charte (complétée par le jumeau) reste la section RÔLE —
  // les instructions métier restent en tête.
  const structuredSystem = composeStructuredPrompt({
    role: charterAvecJumeau,
    method: REASONING_DIRECTIVE,
    constraints: [
      "Comprends la demande actuelle à la lumière de tout l'historique fourni.",
      "N'invente jamais un fait, une action exécutée, un résultat ou une source.",
      "Si une information manque, dis-le au lieu de la compléter par supposition.",
      "Retourne uniquement le résultat demandé par l'utilisateur ; ta réflexion préparatoire reste interne.",
    ],
    outputFormat: RESPONSE_FORMAT_RULES,
    // Few-shot : 1 à 2 exemples de qualité supérieure, sélectionnés
    // DÉTERMINISTEMENT selon la famille de la demande (aucun exemple pour
    // les échanges triviaux — le prompt reste court).
    examples: buildFewShotSection(message),
  });
  // Fenêtre de contexte (Task 42, axe 1) : au lieu d'une troncature brutale
  // aux 12 derniers messages (qui perdait le fil des longues conversations),
  // l'historique ENTIER est tenu dans la fenêtre du modèle — récents
  // verbatim + condensé extractif des plus anciens (aucune invention).
  const { messages } = assembleMessages({
    system: structuredSystem,
    history: history.map((item) => ({ role: item.role, content: item.content })),
    message: userContent,
    model: agent.preferredModel ?? null,
    reservedOutputTokens: 4_096,
    keepRecent: 12,
  });
  // VISION : les images jointes sont rattachées au dernier message
  // utilisateur (contrat AIMessage.images — parts réelles par provider).
  if (images && images.length > 0) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (candidate && candidate.role === "user") {
        messages[index] = { ...candidate, images };
        break;
      }
    }
  }
  const response = await generate({
    task: "chat",
    messages,
    // Task 52 : réponse VISIBLE → routage qualité (meilleur fournisseur
    // configuré en mode premium, comportement gratuit en mode free).
    preferFree: preferFreeForVisibleAnswers(),
    maxTokens: 4096,
    metadata: { purpose: "agent-chat-answer" },
  });
  // Anti-balises : le raisonnement interne de certains modèles (<think>…)
  // ne doit jamais atteindre l'utilisateur.
  const draft = cleanRequestedResult(stripThinkTags(response.text.trim()));
  // Task 138 — SELF-REFLECTION : l'agent critique sa propre production
  // AVANT livraison (exactitude, complétude, fiabilité, structure). Une
  // seule passe, uniquement sur les réponses substantielles ; fail-soft
  // total — une panne du réviseur rend la proposition d'origine.
  const reviewed = await reviewVisibleAnswer({ question: message, answer: draft, contextNote });
  return reviewed.text;
}

/**
 * Réponse déterministe quand la demande est MATERIELLEMENT IMPOSSIBLE
 * (aucune capacité disponible même avec les outils fournis) : honnête,
 * instantanée et sans coût LLM. Elle explique ce qui manque et ce qui reste
 * possible — elle ne rejette JAMAIS au motif du domaine de l'agent : les
 * agents Gen3ia sont polyvalents (charte « PÉRIMÈTRE & POLYVALENCE »).
 */
export function unavailableCapabilityReply(agent: Pick<AgentRecord, "name" | "type" | "typeLabel" | "skills">, message: string): string {
  const label = labelForAgent(agent);
  const skills = (agent.skills ?? []).filter(Boolean).slice(0, 5);
  const excerpt = message.trim().slice(0, 120);
  return [
    `Je suis ${agent.name}, votre agent ${label} sur Gen3ia.`,
    "",
    `Votre demande${excerpt ? ` (« ${excerpt}${message.trim().length > 120 ? "…" : ""} »)` : ""} nécessite une capacité qui n'est pas disponible pour le moment (aucun outil, connecteur ou service fourni ne permet de la réaliser réellement). Je préfère vous le dire honnêtement plutôt que de simuler un résultat.`,
    "",
    `Ce que je peux faire dès maintenant : répondre à toutes vos questions et exécuter des tâches avec les outils fournis (recherche web, fichiers, code, applications connectées)${skills.length ? `, et en particulier ${skills.join(", ")}` : ""}. Reformulez votre besoin avec ces moyens — ou connectez l'application nécessaire depuis les intégrations Gen3ia — et je m'en occupe de bout en bout.`,
  ].join("\n");
}

/**
 * Plan d'exécution (mode "task") pour un agent personnalisé :
 *  - la charte est injectée dans le prompt du planificateur (aucune étape
 *    hors périmètre ne doit être planifiée) ;
 *  - le catalogue d'outils présenté au planificateur est restreint aux
 *    outils autorisés par la politique de sécurité de l'agent.
 */
export async function planAgentTask(userId: string, agent: AgentRecord, objective: string): Promise<RuntimePlan> {
  const policy = policyForAgent(agent);
  // Le runtime autorise ensuite l'exécution externe uniquement contre les
  // connexions effectivement vérifiées. Le planificateur doit donc pouvoir
  // proposer composio.execute quand un connecteur connecté est pertinent.
  const allowed = [...new Set([...(policy.allowedTools ?? []), "composio.execute"])];
  // Task 114-b — Jumeau créatif : la directive est COMPOSÉE avec la charte
  // dans le config passé à planUniversalAgent (chemin agent) — le chemin
  // universel (sans charte) est couvert côté unified-agent, jamais en double.
  let charterAvecJumeau = buildAgentCharter(agent);
  try {
    const jumeau = await twinDirectiveForUser(userId);
    if (jumeau) charterAvecJumeau = `${charterAvecJumeau}\n\n${jumeau}`;
  } catch (error) {
    console.warn("[agent-chat] directive du jumeau indisponible, mission sans jumeau :", error instanceof Error ? error.message : error);
  }
  // Fournisseur fixé par le propriétaire : le routeur valide la valeur (un
  // fournisseur inconnu est simplement ignoré par selectProvider).
  const fixedProvider = agent.modelStrategy === "fixed" && agent.preferredProvider
    ? (agent.preferredProvider as AIProvider)
    : undefined;
  // Sous-agents délégables : résolus depuis la liste blanche du propriétaire,
  // le planner ne voit que des agents réels, actifs et possédés.
  const subAgents = (agent.subAgentIds ?? []).length > 0
    ? (await Promise.all((agent.subAgentIds ?? []).map((id) => getAgentForUser(userId, id))))
        .filter((sub): sub is NonNullable<typeof sub> => Boolean(sub && sub.status === "active"))
        .map((sub) => ({ id: sub.id, name: sub.name, description: sub.description, typeLabel: sub.typeLabel }))
    : [];
  return planUniversalAgent(userId, objective, {
    agent: {
      charter: charterAvecJumeau,
      allowedTools: allowed,
      subAgents,
    },
    provider: fixedProvider,
    model: agent.modelStrategy === "fixed" ? agent.preferredModel : undefined,
  });
}

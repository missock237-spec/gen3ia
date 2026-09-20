import { generate } from "../ai/router";
import type { AIProvider } from "../ai/models";
import { planUniversalAgent } from "./runtime/unified-agent";
import type { RuntimePlan } from "./runtime/types";
import { policyForAgent } from "./personalized-plan";
import { buildAgentCharter, labelForAgent } from "./charter";
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

export interface RequestClassification {
  mode: ChatRequestMode;
  inScope: boolean;
  reason: string;
}

const CLASSIFIER_SYSTEM = [
  "Tu es le classificateur de requêtes des agents IA Gen3ia.",
  "On te donne la charte d'un agent (son domaine, ses compétences) et le message d'un utilisateur.",
  "Tu décides, en comparant la charte et le message :",
  "1. mode: \"chat\" si le message appelle une réponse claire et simple (salutation, question, explication, conseil, reformulation, discussion) — l'agent répond directement comme un LLM ;",
  "mode: \"task\" si le message demande de RÉALISER quelque chose de concret dans le domaine de l'agent (produire un livrable, exécuter, créer, rechercher des données, préparer un document) — l'agent agit alors comme un professionnel qui exécute la tâche pour laquelle il a été créé.",
  "2. inScope: false si le message relève CLAIREMENT d'un autre domaine que celui de l'agent (exemple : une stratégie marketing pour un agent de code). inScope: true sinon, y compris pour les salutations.",
  "3. reason: une courte justification en français.",
  "Réponds STRICTEMENT en JSON : {\"mode\":\"chat|task\",\"inScope\":true|false,\"reason\":\"...\"}",
].join(" ");

/**
 * Repli déterministe quand le classificateur LLM est indisponible :
 * les messages interrogatifs courts et sans verbe d'action obtiennent une
 * réponse directe, tout le reste suit le comportement d'exécution historique.
 */
export function heuristicClassification(message: string): RequestClassification {
  const text = message.trim().toLowerCase();
  const isQuestion = /\?\s*$/.test(text) || /^(bonjour|salut|bonsoir|hello|coucou|merci|qui es|tu es|c'est quoi|qu'est-ce|comment|pourquoi|quel|quelle|quels|quelles|peux-tu m'expliquer|explique(-moi)?)\b/.test(text);
  const hasActionVerb = /\b(cr[ée]e|g[ée]n[èe]re|r[ée]dige|analyse|envoie|ex[ée]cute|construis|programme|publie|pr[ée]pare|t[ée]l[ée]charge|converts|impl[ée]mente|corrige|d[ée]ploie|liste(-moi)?|trouve(-moi)?|cherche(-moi)?)\b/.test(text);
  const shortConversational = text.length <= 400 && !hasActionVerb;
  const mode: ChatRequestMode = isQuestion && shortConversational ? "chat" : "task";
  return { mode, inScope: true, reason: "Classification heuristique (classificateur IA indisponible)." };
}

function normalizeMode(value: unknown): ChatRequestMode | null {
  return value === "chat" || value === "task" ? value : null;
}

export async function classifyRequest(agent: Pick<AgentRecord, "name" | "description" | "type" | "typeLabel" | "skills">, message: string): Promise<RequestClassification> {
  const charter = buildAgentCharter(agent);
  try {
    const response = await generate({
      task: "agent",
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM },
        { role: "user", content: JSON.stringify({ charte: charter, message }) },
      ],
      requiresStructuredOutput: true,
      preferFree: true,
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
        return {
          mode,
          inScope: record.inScope !== false,
          reason: typeof record.reason === "string" ? record.reason.slice(0, 300) : "",
        };
      }
    }
    return heuristicClassification(message);
  } catch {
    return heuristicClassification(message);
  }
}

export type ChatHistoryMessage = { role: "user" | "assistant"; content: string };

/**
 * Réponse directe (mode "chat") : la charte de l'agent pilote un appel LLM
 * classique. La charte impose un ton professionnel et le respect du
 * périmètre — le refus hors-domaine est donc déjà couvert ici ; ce mode est
 * utilisé après une classification inScope=true.
 */
export async function answerAsAgent(
  agent: Pick<AgentRecord, "name" | "description" | "type" | "typeLabel" | "skills" | "agentMode" | "memoryFile">,
  history: ChatHistoryMessage[],
  message: string,
  contextNote?: string,
): Promise<string> {
  const charter = buildAgentCharter(agent);
  const userContent = contextNote ? `${contextNote}\n\n${message}` : message;
  const response = await generate({
    task: "chat",
    messages: [
      { role: "system", content: charter },
      ...history.slice(-12).map((item) => ({ role: item.role, content: item.content })),
      { role: "user", content: userContent },
    ],
    preferFree: true,
    maxTokens: 3000,
    metadata: { purpose: "agent-chat-answer" },
  });
  return response.text.trim();
}

/**
 * Refus professionnel déterministe hors-périmètre : fiable, instantané et
 * sans coût LLM. Utilisé quand la classification détecte un message
 * clairement hors du domaine de l'agent.
 */
export function outOfScopeReply(agent: Pick<AgentRecord, "name" | "type" | "typeLabel" | "skills">, message: string): string {
  const label = labelForAgent(agent);
  const skills = (agent.skills ?? []).filter(Boolean).slice(0, 5);
  const excerpt = message.trim().slice(0, 120);
  return [
    `Je suis ${agent.name}, votre agent ${label} sur Gen3ia.`,
    "",
    `Votre demande${excerpt ? ` (« ${excerpt}${message.trim().length > 120 ? "…" : ""} »)` : ""} sort de mon périmètre d'intervention : je suis strictement spécialisé en ${label.toLowerCase()}${skills.length ? ` et mes compétences couvrent notamment ${skills.join(", ")}` : ""}.`,
    "",
    "Pour rester dans mon cadre, pouvez-vous reformuler votre besoin dans mon domaine ? Je pourrai alors vous livrer un résultat complet et vérifié. Pour un sujet d'une autre nature, créez un agent dédié depuis le Studio Gen3ia : chaque agent y possède son propre périmètre.",
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
  const allowed = policy.allowedTools ?? [];
  // Fournisseur fixé par le propriétaire : le routeur valide la valeur (un
  // fournisseur inconnu est simplement ignoré par selectProvider).
  const fixedProvider = agent.modelStrategy === "fixed" && agent.preferredProvider
    ? (agent.preferredProvider as AIProvider)
    : undefined;
  return planUniversalAgent(userId, objective, {
    agent: {
      charter: buildAgentCharter(agent),
      allowedTools: allowed,
    },
    provider: fixedProvider,
    model: agent.modelStrategy === "fixed" ? agent.preferredModel : undefined,
  });
}

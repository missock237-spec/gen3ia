import "server-only";

/**
 * Contrats de tour + helpers partagés (agent dédié, historique, timeout, budgets temps/tokens, contexte des pièces jointes). Extrait de engine.ts — code déplacé tel quel.
 */

import type { StreamEventEmitter } from "./stream-events";
import type { ConversationApproval, ConversationArtifact, ConversationMessage, ConversationRun, MessageAttachment } from "./types";
import { buildAgentCharter } from "@/lib/agents/charter";
import { getAgentForUser } from "@/lib/agents/repository";
import type { ChatMessage } from "@/lib/chat/repository";
import type { AuthorizationMode } from "@/lib/security/authorization-mode";
import type { TurnIntent } from "./engine-intent";

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
  /** Bouton « Recherche web » du composer : la recherche réelle (web.search)
   *  est FORCÉE pour ce tour — aucun routage heuristique ne peut l'ignorer. */
  webSearch?: boolean;
  /** Parité Gemini — Deep Research gen3 : orchestration multi-axes réelle
   *  (plan → recherches web par axe → pages ouvertes → rapport structuré).
   *  Bouton « Recherche approfondie » du composer ou demande explicite. */
  research?: boolean;
  /** Fuseau horaire du client (IANA) pour les tâches planifiées créées en langage naturel. */
  timezone?: string;
  /** Parité Gemini — budget de raisonnement réel choisi dans le composer :
   *  « rapide ⚡ / équilibré 🎯 / expert 🧠 » pilote fenêtre, budgets temps/
   *  contexte, self-review et directive de raisonnement (effortParameters). */
  reasoningEffort?: ReasoningEffort;
  /**
   * LIVRAISON MÉDIA DURABLE (2026-11-12) — origine https de la REQUÊTE de
   * l'utilisateur (resolue par la route, jamais par le client) : les liens
   * ABSOLUS de médias dans le texte du message suivent l'hôte que
   * l'utilisateur navigue réellement (le cookie de session est host-only —
   * un lien canonique apex serait un 401 pour une session www). Les
   * lecteurs <audio>/<video> du fil utilisent l'URL RELATIVE (toujours
   * correcte) ; ce champ ne sert QU'aux liens textuels. Aucune décision de
   * sécurité n'en dépend (la route /api/media/durable authentifie le
   * LECTEUR de toute façon).
   */
  origineClient?: string;
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
export async function loadTurnAgent(userId: string, agentId: string): Promise<AgentTurnContext | null> {
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

export function historyForModel(history: ChatMessage[], limit = 16) {
  return history.slice(-limit).map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Budget temps par appel IA : la fonction serverless a 60 s (plan Hobby).
 * Chaque étape IA reçoit un délai ferme, avec replis prévus — la fonction
 * rend toujours la main sous le plafond, jamais de 504 opaque.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Délai dépassé (${label})`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export const INTENT_BUDGET_MS = 25_000;
export const CHAT_BUDGET_MS = 35_000;
export const SUMMARY_BUDGET_MS = 15_000;

/**
 * Task 131 — budget de la fenêtre de contexte du tour conversationnel.
 * 24 000 tokens : cohérent avec l'usage LLM du projet (les modèles routés par
 * lib/ai/router acceptent 32k+ ; la marge restante couvre la réponse). En
 * dessous de ce budget, le comportement du moteur reste EXACTEMENT celui
 * d'avant (les 16 derniers messages) — la fenêtre glissante ne s'active que
 * lorsque l'historique déborde réellement du budget.
 */
export const CONTEXT_WINDOW_BUDGET_TOKENS = 24_000;

/* ------------------------------------------------------------------ */
/* Budgets de raisonnement RÉELS (parité Gemini — thinking budgets)     */
/* ------------------------------------------------------------------ */
/* Parité Gemini : les trois niveaux d'effort du composer (rapide ⚡ /
 * équilibré 🎯 / expert 🧠) ne sont plus cosmétiques — chacun pilote
 * maintenant des budgets MOTEUR réels : fenêtre d'historique, budget de
 * contexte, budget temps de génération, relecture anti-désinformation
 * (self-review) et directive de raisonnement au prompt système.        */

export type ReasoningEffort = "rapide" | "equilibre" | "expert";

export interface EffortParameters {
  /** Nombre de messages récents passés au modèle. */
  historyLimit: number;
  /** Budget de la fenêtre de contexte (tokens) pour ce tour. */
  contextBudgetTokens: number;
  /** Budget temps du générateur (ms). */
  chatBudgetMs: number;
  /** La relecture anti-désinformation (self-review) est-elle exécutée ? */
  selfReview: boolean;
  /** Directive de raisonnement injectée au prompt système. */
  directive: string;
  /** Étiquette honnête pour la télémétrie / les événements du flux. */
  etiquette: ReasoningEffort;
}

/** Valeurs par défaut d'équilibre — identiques aux constantes historiques
 *  (aucune régression pour les tours qui ne précisent pas d'effort). */
const DIRECTIVES_EFFORT: Record<ReasoningEffort, string> = {
  rapide:
    "MODE D'EFFORT : rapide — réponds de façon directe et concise (2 à 6 phrases " +
    "sauf demande explicite contraire), va droit au résultat utile, sans " +
    "préambule ni digression, mais sans jamais inventer.",
  equilibre:
    "MODE D'EFFORT : équilibré — réponds avec la précision et la structure " +
    "adaptées à la demande (détail raisonnable, format markdown clair), " +
    "explique les points clés sans développer au-delà de l'utile.",
  expert:
    "MODE D'EFFORT : expert — raisonnes en profondeur avant de répondre : " +
    "cadre le problème, déroule ton analyse étape par étape, examine les " +
    "nuances et les cas limites, compare les options quand c'est pertinent, " +
    "et livre une réponse structurée, complète et argumentée (sections " +
    "markdown, exemples concrets, chiffres vérifiables quand tu en disposes).",
};

/** Résout les paramètres d'effort réels d'un tour (fail-safe : toute valeur
 *  inconnue/absente retombe sur « équilibre », le comportement historique). */
export function effortParameters(effort?: ReasoningEffort | string): EffortParameters {
  const niveau: ReasoningEffort = effort === "rapide" || effort === "expert" ? effort : "equilibre";
  if (niveau === "rapide") {
    return {
      historyLimit: 8,
      contextBudgetTokens: 12_000,
      chatBudgetMs: 20_000,
      selfReview: false,
      directive: DIRECTIVES_EFFORT.rapide,
      etiquette: "rapide",
    };
  }
  if (niveau === "expert") {
    return {
      historyLimit: 32,
      contextBudgetTokens: 48_000,
      chatBudgetMs: 50_000,
      selfReview: true,
      directive: DIRECTIVES_EFFORT.expert,
      etiquette: "expert",
    };
  }
  return {
    historyLimit: 16,
    contextBudgetTokens: CONTEXT_WINDOW_BUDGET_TOKENS,
    chatBudgetMs: CHAT_BUDGET_MS,
    selfReview: true,
    directive: DIRECTIVES_EFFORT.equilibre,
    etiquette: "equilibre",
  };
}

/** Contexte des pièces jointes injecté au modèle (liste) + détails de conversion réelle. */
export function attachmentsContext(attachments?: MessageAttachment[]): string {
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

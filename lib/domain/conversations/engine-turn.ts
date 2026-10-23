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

"use client";

import type { MessageAttachment } from "./types";
import type { ConversationStreamEvent } from "./stream-events";
import type { AuthorizationMode } from "@/lib/security/authorization-mode";

/**
 * Client de consommation du flux conversationnel (NDJSON) : envoie le
 * message à la route de streaming et transmet chaque événement décodé à
 * `onEvent` au fil de l'arrivée. Retourne true si le flux s'est terminé
 * normalement ; lève une exception si la requête échoue AVANT le flux
 * (auth, validation, réseau) — l'appelant bascule alors sur la route
 * classique.
 */

export interface StreamTurnPayload {
  conversationId: string;
  message: string;
  attachments?: MessageAttachment[];
  projectId?: string;
  connectors?: string[];
  /** Mode d'autorisation HITL choisi dans le composer. */
  authorizationMode?: AuthorizationMode;
  /** Fuseau horaire du client (IANA) pour les sous-services pilotés en langage naturel. */
  timezone?: string;
  signal?: AbortSignal;
  onEvent: (event: ConversationStreamEvent) => void;
}

/**
 * Fuseau horaire IANA du client (usage : tâches planifiées créées en
 * langage naturel). Jamais une exception : en cas d'environnement exotique,
 * on renvoie null et le serveur utilisera UTC.
 */
export function safeClientTimezone(): string | undefined {
  try {
    if (typeof Intl === "undefined") return undefined;
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export async function streamConversationTurn(payload: StreamTurnPayload): Promise<boolean> {
  const response = await fetch(`/api/workspace/conversations/${payload.conversationId}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: payload.message,
      ...(payload.attachments && payload.attachments.length > 0 ? { attachments: payload.attachments } : {}),
      ...(payload.projectId ? { projectId: payload.projectId } : {}),
      ...(payload.connectors && payload.connectors.length > 0 ? { connectors: payload.connectors } : {}),
      ...(payload.authorizationMode ? { authorizationMode: payload.authorizationMode } : {}),
      ...(payload.timezone ? { timezone: payload.timezone } : {}),
    }),
    signal: payload.signal,
    cache: "no-store",
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? "Le message n'a pas pu être traité.");
  }
  if (!response.body) {
    throw new Error("Flux indisponible.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;

  const dispatchLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: ConversationStreamEvent;
    try {
      event = JSON.parse(trimmed) as ConversationStreamEvent;
    } catch {
      // Ligne partielle/invalide : ignorée (le flux reste cohérent par ligne).
      return;
    }
    payload.onEvent(event);
    if (event.type === "done") completed = true;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // La dernière ligne peut être incomplète : conservée pour le prochain lot.
    buffer = lines.pop() ?? "";
    for (const line of lines) dispatchLine(line);
  }
  // Reste éventuel sans saut de ligne final.
  dispatchLine(buffer);

  return completed;
}

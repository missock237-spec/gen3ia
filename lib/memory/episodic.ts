import { generate } from "@/lib/ai/router";

import { listAgentMemories } from "./repository";
import { writeMemory } from "./service";
import { createMemoryEmbedding } from "./embeddings";
import { cosineSimilarity } from "./similarity";
import type { MemoryRecord } from "./types";

/**
 * Mémoire épisodique et sémantique des agents personnalisés du Studio.
 *
 * Chaque échange utilisateur/agent est enregistré sous forme de souvenir
 * (embedding inclus) puis retrouvé par similarité sémantique lors des
 * requêtes suivantes : l'agent retrouve les décisions, préférences et
 * discussions passées sans jamais saturer sa fenêtre de contexte.
 * Les longues conversations font l'objet d'un résumé automatique stocké
 * comme souvenir de type "decision".
 */

const RECALL_MIN_SCORE = 0.35;
const RECALL_TOP_K = 3;
const EXCHANGE_CONTENT_MAX = 4_000;
const SUMMARY_EVERY_MESSAGES = 8;
const SUMMARY_MIN_MESSAGES = 8;

function excerpt(value: string, max = 600): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

/**
 * Formate les souvenirs retrouvés en note de contexte injectée dans le
 * prompt de l'agent. Fonction pure : testable sans Firestore.
 */
export function formatRecallNote(
  results: Array<{ memory: Pick<MemoryRecord, "type" | "content" | "createdAt">; score: number }>,
): string | undefined {
  const relevant = results
    .filter((result) => result.score >= RECALL_MIN_SCORE && result.memory.content.trim().length > 0)
    .slice(0, RECALL_TOP_K);
  if (relevant.length === 0) return undefined;

  const labels: Record<string, string> = {
    conversation: "échange passé",
    fact: "fait",
    decision: "décision",
    preference: "préférence",
    execution: "exécution",
    artifact: "livrable",
    project: "projet",
  };

  const lines = relevant.map((result) => {
    const label = labels[result.memory.type] ?? "souvenir";
    const date = result.memory.createdAt ? ` (${result.memory.createdAt.slice(0, 10)})` : "";
    return `- [${label}${date}] ${excerpt(result.memory.content, 400)}`;
  });

  return [
    "[Souvenirs pertinents issus de ta mémoire épisodique (échanges passés avec cet utilisateur) — appuie-toi dessus si cela améliore ta réponse, sans les mentionner explicitement :]",
    ...lines,
  ].join("\n");
}

/** Recherche sémantique scopusée à un agent (embedding de la requête + cosinus). */
export async function searchAgentMemories(
  userId: string,
  agentId: string,
  query: string,
  limit = RECALL_TOP_K,
): Promise<Array<{ memory: MemoryRecord; score: number }>> {
  const memories = await listAgentMemories(userId, agentId, 200);
  const usable = memories.filter((memory) => memory.embedding && memory.embedding.length > 0);
  if (usable.length === 0) return [];

  const queryEmbedding = await createMemoryEmbedding(query);
  return usable
    .map((memory) => ({ memory, score: cosineSimilarity(queryEmbedding, memory.embedding!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}

/**
 * Rappel sémantique pour le chat : retourne une note de contexte prête à
 * injecter, ou undefined. Ne doit JAMAIS faire échouer la conversation.
 */
export async function recallAgentContext(
  userId: string,
  agentId: string,
  query: string,
): Promise<string | undefined> {
  try {
    const results = await searchAgentMemories(userId, agentId, query, RECALL_TOP_K + 2);
    return formatRecallNote(results);
  } catch {
    return undefined;
  }
}

/**
 * Enregistre un échange complet comme souvenir épisodique (embedding inclus).
 * Dégradation silencieuse : si les embeddings sont indisponibles, le souvenir
 * est stocké sans embedding (retrouvable par les listes, pas par similarité).
 */
export async function recordExchange(params: {
  userId: string;
  agentId: string;
  conversationId: string;
  userMessage: string;
  assistantReply: string;
  mode: "chat" | "task";
}): Promise<void> {
  try {
    const content = `Utilisateur : ${excerpt(params.userMessage, 1_500)}\n\nAgent : ${excerpt(params.assistantReply, 2_000)}`;
    await writeMemory({
      userId: params.userId,
      agentId: params.agentId,
      type: "conversation",
      content: content.slice(0, EXCHANGE_CONTENT_MAX),
      importance: params.mode === "task" ? 0.6 : 0.4,
      metadata: {
        kind: "exchange",
        conversationId: params.conversationId,
        mode: params.mode,
        userMessage: excerpt(params.userMessage, 800),
        assistantReply: excerpt(params.assistantReply, 800),
      },
    });
  } catch {
    // La mémoire ne doit jamais faire échouer une conversation.
  }
}

/**
 * Résumé automatique des longues conversations : toutes les
 * SUMMARY_EVERY_MESSAGES iterations, un résumé LLM est stocké comme souvenir
 * de type "decision" — il sert de contexte à long terme sans saturer la
 * fenêtre de contexte de l'agent.
 */
export function shouldSummarize(historyLength: number): boolean {
  return (
    historyLength >= SUMMARY_MIN_MESSAGES &&
    historyLength % SUMMARY_EVERY_MESSAGES === 0
  );
}

export async function summarizeConversation(params: {
  userId: string;
  agentId: string;
  conversationId: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<void> {
  try {
    const transcript = params.history
      .slice(-24)
      .map((item) => `${item.role === "user" ? "Utilisateur" : "Agent"} : ${excerpt(item.content, 700)}`)
      .join("\n\n");

    const response = await generate({
      task: "chat",
      messages: [
        {
          role: "system",
          content:
            "Tu résumes une conversation entre un utilisateur et son agent IA professionnel. Produis un résumé factuel et compact (8 phrases maximum) qui préserve : les décisions prises, les faits et préférences exprimés, les livrables produits et les points en suspens. Ne commente pas, ne salue pas : renvoie UNIQUEMENT le résumé.",
        },
        { role: "user", content: transcript },
      ],
      preferFree: true,
      maxTokens: 800,
      metadata: { purpose: "memory-auto-summary" },
    });

    const summary = response.text.trim();
    if (!summary) return;

    await writeMemory({
      userId: params.userId,
      agentId: params.agentId,
      type: "decision",
      content: `Résumé de conversation (${new Date().toISOString().slice(0, 10)}) : ${summary}`.slice(0, EXCHANGE_CONTENT_MAX),
      importance: 0.75,
      metadata: { kind: "auto-summary", conversationId: params.conversationId },
    });
  } catch {
    // Le résumé est un plus : jamais bloquant.
  }
}

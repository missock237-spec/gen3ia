/**
 * Index vectoriel des messages de conversation (Qdrant).
 *
 * Objectif « Historique persistant et recherche » : permettre de retrouver
 * une conversation par le SENS de son contenu (recherche sémantique), et non
 * plus uniquement par correspondance littérale du titre.
 *
 * Architecture identique aux mémoires et à la base de connaissances :
 *  - Firestore (`chatMessages`) reste la SOURCE DE VÉRITÉ ;
 *  - Qdrant (`gen3ia_conversations`) est un INDEX de recherche portant le
 *    vecteur d'embedding du message + un payload minimal de filtrage
 *    (userId obligatoire — sécurité multi-tenant, conversationId, messageId,
 *    role, createdAt, preview).
 *
 * Toute opération est « fail-soft » : Qdrant absent, quota HuggingFace
 * épuisé ou erreur réseau ne DOIVENT jamais casser l'envoi d'un message ni
 * la recherche (les appelants retombent sur la recherche textuelle
 * Firestore). La collection utilise la MÊME dimension que les autres
 * collections Gen3ia (MiniLM 384) — un seul modèle d'embedding pour tout le
 * projet, cohérence des vecteurs garantie.
 */

import { v5 as uuidV5 } from "uuid";

import {
  searchVectorPoints,
  upsertVectorPoints,
} from "@/lib/memory/vector-store";

import { createMemoryEmbedding } from "@/lib/memory/embeddings";

export const CONVERSATION_VECTOR_COLLECTION = "gen3ia_conversations";

/** Espace de noms UUID v5 Gen3ia : IDs de points déterministes et idempotents. */
const GEN3IA_POINT_NAMESPACE = "6f1c2a34-9b7e-4d58-a1f0-2c9d4e7b8a11";

/** Taille maximale du texte indexé (au-delà : troncation, pas de rejet). */
const MAX_INDEXED_CHARS = 4_000;

/** Aperçu stocké dans le payload pour afficher le hit sans relire Firestore. */
const PREVIEW_CHARS = 240;

export interface ConversationIndexInput {
  messageId: string;

  conversationId: string;

  userId: string;

  role: string;

  content: string;

  createdAt?: string;

  projectId?: string | null;
}

export interface ConversationSearchHit {
  messageId: string;

  conversationId: string;

  role: string;

  /** Aperçu du message correspondant (stocké dans le payload Qdrant). */
  preview: string;

  createdAt: string;

  /** Score de similarité cosinus (0 → 1, plus grand = plus proche). */
  score: number;
}

/**
 * Indexe un message dans Qdrant. Appelé après la persistance Firestore de
 * chaque message (utilisateur ET assistant). Toute erreur est avalée et
 * journalisée : l'indexation est un enrichissement, jamais une dépendance.
 *
 * L'ID du point est déterministe (UUID v5 du messageId) : réindexer un
 * message écrase son point au lieu d'en créer un doublon — les relances
 * d'indexation (backfill, corrections) restent idempotentes.
 */
export async function indexConversationMessage(input: ConversationIndexInput): Promise<boolean> {
  const content = (input.content ?? "").trim();
  if (!input.messageId || !input.conversationId || !input.userId || content.length < 2) {
    return false;
  }

  try {
    const vector = await createMemoryEmbedding(content.slice(0, MAX_INDEXED_CHARS));
    if (!Array.isArray(vector) || vector.length === 0) return false;

    return await upsertVectorPoints(CONVERSATION_VECTOR_COLLECTION, [
      {
        id: uuidV5(input.messageId, GEN3IA_POINT_NAMESPACE),
        vector,
        payload: {
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          projectId: input.projectId ?? null,
          role: input.role,
          createdAt: input.createdAt ?? new Date().toISOString(),
          // Aperçu court pour afficher les hits sans re-lire Firestore.
          preview: content.slice(0, PREVIEW_CHARS),
        },
      },
    ]);
  } catch (error) {
    // Fail-soft : l'embedding (réseau HF) est la cause la plus probable.
    console.warn(
      JSON.stringify({
        event: "conversation_index_failed",
        conversationId: input.conversationId,
        messageId: input.messageId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}

/**
 * Regroupe des hits bruts (plusieurs messages par conversation) en UN hit
 * par conversation : dédoublonnage par messageId (rééditions), puis seul le
 * message au meilleur score de chaque conversation est conservé, triés par
 * pertinence décroissante. Fonction pure, testée unitairement.
 */
export function bestHitPerConversation(hits: ConversationSearchHit[]): ConversationSearchHit[] {
  const parMessage = new Map<string, ConversationSearchHit>();
  for (const hit of hits) {
    const existing = parMessage.get(hit.messageId);
    if (!existing || hit.score > existing.score) {
      parMessage.set(hit.messageId, hit);
    }
  }

  const parConversation = new Map<string, ConversationSearchHit>();
  for (const hit of parMessage.values()) {
    const existing = parConversation.get(hit.conversationId);
    if (!existing || hit.score > existing.score) {
      parConversation.set(hit.conversationId, hit);
    }
  }

  return [...parConversation.values()].sort((a, b) => b.score - a.score);
}

/**
 * Recherche sémantique dans les messages de l'utilisateur. Retourne null si
 * Qdrant/embeddings ne sont pas configurés ou en panne → l'appelant bascule
 * sur la recherche textuelle Firestore (comportement historique).
 */
export async function searchConversationMessages(
  userId: string,
  query: string,
  options: { limit?: number; projectId?: string | null } = {},
): Promise<ConversationSearchHit[] | null> {
  const trimmed = (query ?? "").trim();
  if (trimmed.length < 2) return null;

  try {
    const vector = await createMemoryEmbedding(trimmed.slice(0, MAX_INDEXED_CHARS));
    if (!Array.isArray(vector) || vector.length === 0) return null;

    const hits = await searchVectorPoints(CONVERSATION_VECTOR_COLLECTION, vector, {
      limit: Math.max(1, Math.min(20, options.limit ?? 8)),
      filter: {
        userId,
        ...(options.projectId ? { projectId: options.projectId } : {}),
      },
    });

    // null = Qdrant indisponible (distinguable d'une absence de résultat).
    if (hits === null) return null;

    return hits
      .map((hit) => ({
        messageId: String(hit.payload?.messageId ?? hit.id),
        conversationId: String(hit.payload?.conversationId ?? ""),
        role: String(hit.payload?.role ?? "user"),
        preview: String(hit.payload?.preview ?? ""),
        createdAt: String(hit.payload?.createdAt ?? ""),
        score: hit.score,
      }))
      .filter((hit) => hit.conversationId.length > 0);
  } catch {
    return null;
  }
}

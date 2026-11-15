import {
  listProjectMemories,
  getMemory,
} from "./repository";

import {
  createMemoryEmbedding,
} from "./embeddings";

import {
  cosineSimilarity,
} from "./similarity";

import {
  VECTOR_COLLECTION_MEMORIES,
  searchVectorPoints,
} from "./vector-store";

export interface MemorySearchResult {
  memory: Awaited<
    ReturnType<
      typeof listProjectMemories
    >
  >[number];

  score: number;
}

/**
 * Recherche sémantique des mémoires d'un projet.
 *
 * Chemin rapide (Qdrant configuré) : requête kNN filtrée par userId +
 * projectId, puis rechargement des documents complets depuis Firestore
 * (source de vérité) pour garantir des données à jour.
 *
 * Chemin de repli (Qdrant absent/en erreur) : parcours Firestore historique
 * (≤ 200 mémoires) + classement cosinus en mémoire.
 */
export async function searchMemories(
  userId: string,
  projectId: string,
  query: string,
  limit = 8,
): Promise<MemorySearchResult[]> {
  const queryEmbedding =
    await createMemoryEmbedding(
      query,
    );

  const hits =
    await searchVectorPoints(
      VECTOR_COLLECTION_MEMORIES,
      queryEmbedding,
      {
        limit,
        filter: { userId, projectId },
      },
    );

  if (hits && hits.length > 0) {
    const results = await Promise.all(
      hits.map(async (hit) => {
        const memory = await getMemory(hit.id);
        return memory ? { memory, score: hit.score } : null;
      }),
    );

    const valid = results
      .filter((result): result is MemorySearchResult => result !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (valid.length > 0) return valid;
    // Index en avance/retard de phase sur Firestore (points supprimés,
    // écritures récentes non encore miroir) : on bascule sur le repli.
  }

  const memories =
    await listProjectMemories(
      userId,
      projectId,
      200,
    );

  if (memories.length === 0) {
    return [];
  }

  return memories
    .filter(
      (memory) =>
        memory.embedding &&
        memory.embedding.length > 0,
    )
    .map((memory) => ({
      memory,

      score:
        cosineSimilarity(
          queryEmbedding,
          memory.embedding!,
        ),
    }))
    .sort(
      (a, b) =>
        b.score - a.score,
    )
    .slice(0, limit);
}

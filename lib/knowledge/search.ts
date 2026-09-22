import {
  adminDb,
} from "@/lib/firebase/admin";

import {
  createMemoryEmbedding,
} from "@/lib/memory/embeddings";

import {
  cosineSimilarity,
} from "@/lib/memory/similarity";

import {
  VECTOR_COLLECTION_KNOWLEDGE,
  searchVectorPoints,
} from "@/lib/memory/vector-store";

export interface KnowledgeSearchResult {
  id: string;

  documentId: string;

  text: string;

  chunkIndex: number;

  score: number;
}

/**
 * Recherche dans la base de connaissances.
 *
 * Chemin rapide (Qdrant configuré) : kNN filtré userId + projectId, texte
 * du fragment repris du payload (identique au Firestore : écrit ensemble).
 *
 * Chemin de repli : parcours Firestore (≤ 500 fragments) + cosinus en
 * mémoire — comportement historique, conservé pour la résilience.
 */
export async function searchKnowledge(
  userId: string,
  projectId: string,
  query: string,
  limit = 8,
): Promise<KnowledgeSearchResult[]> {
  const queryEmbedding =
    await createMemoryEmbedding(
      query,
    );

  const hits =
    await searchVectorPoints(
      VECTOR_COLLECTION_KNOWLEDGE,
      queryEmbedding,
      {
        limit,
        filter: { userId, projectId },
      },
    );

  if (hits && hits.length > 0) {
    return hits.map((hit) => ({
      id: hit.id,
      documentId: String(hit.payload.documentId ?? ""),
      text: String(hit.payload.text ?? hit.payload.preview ?? ""),
      chunkIndex: Number(hit.payload.chunkIndex ?? 0),
      score: hit.score,
    }));
  }

  const snapshot =
    await adminDb
      .collection(
        "knowledgeChunks",
      )
      .where(
        "userId",
        "==",
        userId,
      )
      .where(
        "projectId",
        "==",
        projectId,
      )
      .limit(500)
      .get();

  if (snapshot.empty) {
    return [];
  }

  return snapshot.docs
    .map((doc) => {
      const data =
        doc.data();

      return {
        id: doc.id,

        documentId:
          data.documentId,

        text:
          data.text,

        chunkIndex:
          data.chunkIndex,

        score:
          cosineSimilarity(
            queryEmbedding,
            data.embedding ?? [],
          ),
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score,
    )
    .slice(0, limit);
}

import {
  randomUUID,
} from "crypto";

import {
  adminDb,
} from "@/lib/firebase/admin";

import {
  chunkText,
} from "./chunker";

import {
  createMemoryEmbedding,
} from "@/lib/memory/embeddings";

import {
  VECTOR_COLLECTION_KNOWLEDGE,
  upsertVectorPoints,
} from "@/lib/memory/vector-store";

/**
 * Indexe un document de connaissances : découpage en fragments, embeddings
 * HuggingFace, persistance Firestore (source de vérité) puis miroir
 * vectoriel Qdrant (best-effort : l'indexation Firestore ne doit jamais
 * échouer à cause du vector store).
 */
export async function indexKnowledgeDocument(
  input: {
    userId: string;
    projectId: string;
    documentId: string;
    text: string;
  },
): Promise<number> {
  const chunks =
    chunkText(input.text);

  const batch =
    adminDb.batch();

  const vectorPoints: Array<{
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
  }> = [];

  for (const chunk of chunks) {
    const embedding =
      await createMemoryEmbedding(
        chunk.text,
      );

    const ref =
      adminDb
        .collection(
          "knowledgeChunks",
        )
        .doc(
          randomUUID(),
        );

    batch.set(ref, {
      userId:
        input.userId,

      projectId:
        input.projectId,

      documentId:
        input.documentId,

      chunkIndex:
        chunk.index,

      text:
        chunk.text,

      start:
        chunk.start,

      end:
        chunk.end,

      embedding,

      createdAt:
        new Date().toISOString(),
    });

    vectorPoints.push({
      id: ref.id,
      vector: embedding,
      payload: {
        userId: input.userId,
        projectId: input.projectId,
        documentId: input.documentId,
        chunkIndex: chunk.index,
        // Texte complet du fragment : évite un aller-retour Firestore par
        // hit au moment de la recherche (les fragments sont bornés par le
        // chunker, taille maîtrisée).
        text: chunk.text,
        preview: chunk.text.slice(0, 240),
      },
    });
  }

  await batch.commit();

  // Miroir vectoriel après commit Firestore (best-effort, non bloquant
  // pour le résultat métier : le nombre de fragments reste la vérité).
  if (vectorPoints.length > 0) {
    try {
      await upsertVectorPoints(
        VECTOR_COLLECTION_KNOWLEDGE,
        vectorPoints,
      );
    } catch {
      // Absorbé : la recherche retombera sur le parcours Firestore.
    }
  }

  return chunks.length;
}

import {
  FieldValue,
} from "firebase-admin/firestore";

import {
  adminDb,
} from "@/lib/firebase/admin";

import {
  MemoryRecord,
} from "./types";

import {
  VECTOR_COLLECTION_MEMORIES,
  upsertVectorPoints,
} from "./vector-store";

function collection() {
  return adminDb.collection(
    "memories",
  );
}

/**
 * Miroir vectoriel best-effort : Firestore reste la source de vérité,
 * Qdrant accélère la recherche sémantique. Toute erreur est absorbée
 * (l'écriture Firestore ne doit JAMAIS échouer à cause de l'index).
 */
async function mirrorMemoryToVectorStore(memory: MemoryRecord): Promise<void> {
  if (!memory.embedding || memory.embedding.length === 0) return;
  try {
    await upsertVectorPoints(VECTOR_COLLECTION_MEMORIES, [
      {
        id: memory.id,
        vector: memory.embedding,
        payload: {
          userId: memory.userId,
          projectId: memory.projectId ?? null,
          agentId: memory.agentId ?? null,
          memoryId: memory.id,
          type: memory.type ?? null,
          // Aperçu court pour l'affichage des hits sans re-lire Firestore.
          preview: (memory.content ?? "").slice(0, 240),
        },
      },
    ]);
  } catch {
    // Fail-soft assumé : la recherche retombera sur le parcours Firestore.
  }
}

export async function saveMemory(
  memory: MemoryRecord,
): Promise<void> {
  await collection()
    .doc(memory.id)
    .set({
      ...memory,

      embedding:
        memory.embedding ?? null,

      updatedAt:
        FieldValue.serverTimestamp(),
    });

  // Miroir vectoriel (best-effort, après la persistance Firestore).
  await mirrorMemoryToVectorStore(memory);
}

export async function getMemory(
  memoryId: string,
): Promise<MemoryRecord | null> {
  const snapshot =
    await collection()
      .doc(memoryId)
      .get();

  if (!snapshot.exists) {
    return null;
  }

  return snapshot.data() as MemoryRecord;
}

export async function listProjectMemories(
  userId: string,
  projectId: string,
  limit = 100,
): Promise<MemoryRecord[]> {
  const snapshot =
    await collection()
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
      .orderBy(
        "updatedAt",
        "desc",
      )
      .limit(limit)
      .get();

  return snapshot.docs.map(
    (doc) =>
      doc.data() as MemoryRecord,
  );
}

export async function listAgentMemories(
  userId: string,
  agentId: string,
  limit = 200,
): Promise<MemoryRecord[]> {
  const snapshot =
    await collection()
      .where("userId", "==", userId)
      .where("agentId", "==", agentId)
      .orderBy("updatedAt", "desc")
      .limit(limit)
      .get();

  return snapshot.docs.map(
    (doc) =>
      doc.data() as MemoryRecord,
  );
}

import {
  FieldValue,
} from "firebase-admin/firestore";

import {
  adminDb,
} from "@/lib/firebase/admin";

import {
  MemoryRecord,
} from "./types";

function collection() {
  return adminDb.collection(
    "memories",
  );
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

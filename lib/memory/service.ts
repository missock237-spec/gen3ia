import {
  randomUUID,
} from "crypto";

import {
  MemoryType,
  MemoryRecord,
} from "./types";

import {
  saveMemory,
} from "./repository";

import {
  createMemoryEmbedding,
} from "./embeddings";

export interface WriteMemoryInput {
  userId: string;

  projectId?: string;

  agentId?: string;

  type: MemoryType;

  content: string;

  metadata?: Record<
    string,
    unknown
  >;

  importance?: number;
}

export async function writeMemory(
  input: WriteMemoryInput,
): Promise<MemoryRecord> {
  const now =
    new Date().toISOString();

  const memory: MemoryRecord = {
    id: randomUUID(),

    userId:
      input.userId,

    projectId:
      input.projectId,

    agentId:
      input.agentId,

    type:
      input.type,

    content:
      input.content,

    metadata:
      input.metadata ?? {},

    embedding:
      await createMemoryEmbedding(
        input.content,
      ),

    importance:
      input.importance ?? 0.5,

    createdAt: now,

    updatedAt: now,
  };

  await saveMemory(memory);

  return memory;
}

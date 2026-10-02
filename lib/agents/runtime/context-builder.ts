import {
  searchMemories,
} from "@/lib/memory/search";

import {
  resolveKnowledgeScope,
  searchKnowledge,
} from "@/lib/knowledge/search";

export interface AgentContextInput {
  userId: string;

  projectId?: string;

  agentId?: string;

  query: string;
}

export async function buildAgentContext(
  input: AgentContextInput,
) {
  const memoryPromise =
    input.projectId
      ? searchMemories(
          input.userId,
          input.projectId,
          input.query,
          5,
        )
      : Promise.resolve([]);

  const knowledgePromise =
    input.projectId
      ? resolveKnowledgeScope(input.userId).then((orgIds) =>
          searchKnowledge(
            input.userId,
            input.projectId!,
            input.query,
            8,
            orgIds,
          ))
      : Promise.resolve([]);

  const [
    memories,
    knowledge,
  ] = await Promise.all([
    memoryPromise,
    knowledgePromise,
  ]);

  return {
    memories:
      memories.map(
        (item) => ({
          content:
            item.memory.content,

          score:
            item.score,

          type:
            item.memory.type,
        }),
      ),

    knowledge:
      knowledge.map(
        (item) => ({
          documentId:
            item.documentId,

          content:
            item.text,

          score:
            item.score,

          chunkIndex:
            item.chunkIndex,
        }),
      ),
  };
}

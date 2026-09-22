import { z } from "zod";

import type {
  ToolDefinition,
} from "../types";

import {
  searchKnowledge,
} from "@/lib/knowledge/search";

/**
 * Outil knowledge.search — recherche dans la base de connaissances du
 * projet (documents indexés par l'utilisateur). Recherche vectorielle
 * Qdrant lorsque le vector store est configuré, repli Firestore cosinus.
 * Filtrage multi-tenant strict : userId (et projectId si fourni) sont
 * imposés côté serveur, jamais lus depuis l'entrée de l'agent.
 */
const KnowledgeSearchInput =
  z.object({
    query:
      z.string()
        .min(2)
        .max(2_000),

    limit:
      z.number()
        .int()
        .min(1)
        .max(20)
        .default(8),
  });

interface KnowledgeSearchOutput {
  results: Array<{
    documentId: string;

    text: string;

    chunkIndex: number;

    score: number;
  }>;

  total: number;
}

export const knowledgeSearchTool:
  ToolDefinition<
    z.infer<
      typeof KnowledgeSearchInput
    >,
    KnowledgeSearchOutput
  > = {
    id:
      "knowledge.search",

    name:
      "Knowledge Search",

    description:
      "Search the project knowledge base: documents indexed by the user (vector search, tenant-scoped).",

    category:
      "database",

    risk:
      "low",

    inputSchema:
      KnowledgeSearchInput,

    execute:
      async (input, context) => {
        if (!context.projectId) {
          // Sans projet : on retourne une réponse explicite plutôt qu'un
          // parcours non borné — l'agent sait que le service demande un
          // projet et ne tentera pas une lecture globale.
          return { results: [], total: 0 };
        }
        const hits = await searchKnowledge(context.userId, context.projectId, input.query, input.limit);
        return {
          results: hits.map((hit) => ({
            documentId: String(hit.documentId ?? ""),
            text: String(hit.text ?? "").slice(0, 4_000),
            chunkIndex: Number(hit.chunkIndex ?? 0),
            score: hit.score,
          })),
          total: hits.length,
        };
      },
  };

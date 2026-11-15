import { z } from "zod";

export const KnowledgeDocumentSchema =
  z.object({
    id: z.string(),

    userId: z.string(),

    projectId: z.string(),

    name: z.string(),

    mimeType: z.string(),

    source:
      z.enum([
        "upload",
        "url",
        "generated",
        "integration",
      ]),

    storagePath:
      z.string().optional(),

    text:
      z.string().optional(),

    metadata:
      z.record(
        z.string(),
        z.unknown(),
      ).default({}),

    createdAt: z.string(),

    updatedAt: z.string(),
  });

export type KnowledgeDocument =
  z.infer<
    typeof KnowledgeDocumentSchema
  >;

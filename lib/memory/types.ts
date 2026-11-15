import { z } from "zod";

export const MemoryTypeSchema = z.enum([
  "conversation",
  "fact",
  "decision",
  "preference",
  "execution",
  "artifact",
  "project",
]);

export type MemoryType = z.infer<
  typeof MemoryTypeSchema
>;

export const MemoryRecordSchema = z.object({
  id: z.string(),

  userId: z.string(),

  projectId: z.string().optional(),

  agentId: z.string().optional(),

  type: MemoryTypeSchema,

  content: z.string().min(1),

  metadata: z
    .record(z.string(), z.unknown())
    .default({}),

  embedding: z
    .array(z.number())
    .optional(),

  importance: z
    .number()
    .min(0)
    .max(1)
    .default(0.5),

  createdAt: z.string(),

  updatedAt: z.string(),
});

export type MemoryRecord = z.infer<
  typeof MemoryRecordSchema
>;

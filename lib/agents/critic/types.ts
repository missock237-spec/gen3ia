import { z } from "zod";

export const CriticIssueSchema = z.object({
  severity: z.enum([
    "low",
    "medium",
    "high",
    "critical",
  ]),

  category: z.enum([
    "accuracy",
    "completeness",
    "quality",
    "relevance",
    "tool_failure",
    "hallucination",
    "format",
    "constraint",
    "security",
  ]),

  description: z.string().min(1),

  affectedSteps: z
    .array(z.string())
    .default([]),
});

export const CriticCorrectionSchema =
  z.object({
    action: z.string().min(1),

    affectedSteps: z
      .array(z.string())
      .default([]),

    priority: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5),
  });

export const CriticResultSchema = z.object({
  score: z.number().min(0).max(1),

  passed: z.boolean(),

  summary: z.string(),

  issues: z
    .array(CriticIssueSchema)
    .default([]),

  corrections: z
    .array(CriticCorrectionSchema)
    .default([]),

  retry: z.boolean(),

  retrySteps: z
    .array(z.string())
    .default([]),
});

export type CriticResult = z.infer<
  typeof CriticResultSchema
>;

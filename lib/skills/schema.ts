import { z } from "zod";

export const SkillCapabilitySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

export const SkillInputSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  description: z.string().min(1),
  required: z.boolean(),
});

export const SkillOutputSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  description: z.string().min(1),
});

export const SkillDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),

  version: z.number().int().positive(),

  category: z.string().min(1),

  capabilities: z.array(SkillCapabilitySchema),

  inputs: z.array(SkillInputSchema),

  outputs: z.array(SkillOutputSchema),

  triggers: z.array(z.string()),

  requiredTools: z.array(z.string()),

  compatibleTasks: z.array(z.string()),

  systemInstructions: z.string().min(1),

  executionInstructions: z.string().min(1),

  evaluationCriteria: z.array(z.string()),

  status: z.enum([
    "draft",
    "testing",
    "active",
    "deprecated",
    "failed",
  ]),

  visibility: z.enum([
    "system",
    "private",
  ]),

  authorId: z.string().nullable(),

  createdAt: z.string(),
  updatedAt: z.string(),
});

export const SkillFactoryRequestSchema = z.object({
  objective: z.string().min(10),

  taskType: z.string().min(1),

  requiredCapabilities: z.array(z.string()).default([]),

  requiredTools: z.array(z.string()).default([]),

  constraints: z.array(z.string()).default([]),

  expectedOutput: z.string().optional(),
});

export const SkillEvaluationSchema = z.object({
  skillId: z.string(),

  version: z.number().int().positive(),

  score: z.number().min(0).max(100),

  reliability: z.number().min(0).max(100),

  usefulness: z.number().min(0).max(100),

  correctness: z.number().min(0).max(100),

  latencyScore: z.number().min(0).max(100),

  passed: z.boolean(),

  failures: z.array(z.string()),

  improvements: z.array(z.string()),

  evaluatedAt: z.string(),
});

export type SkillDefinitionInput =
  z.infer<typeof SkillDefinitionSchema>;

export type SkillFactoryRequest =
  z.infer<typeof SkillFactoryRequestSchema>;

export type SkillEvaluation =
  z.infer<typeof SkillEvaluationSchema>;

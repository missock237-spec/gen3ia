import { z } from "zod";

export const PlannerStepSchema = z.object({
  id: z.string().min(1),

  type: z.enum([
    "llm",
    "tool",
    "research",
    "document",
    "media",
    "code",
    "condition",
    "agent",
  ]),

  name: z.string().min(1),

  description: z.string().min(1),

  dependencies: z.array(z.string()).default([]),

  skillIds: z.array(z.string()).default([]),

  toolName: z.string().optional(),

  // Étapes de type "agent" : délégation à un sous-agent du Studio
  // (id obligatoirement présent dans la liste de sous-agents autorisés
  // fournie au planner — voir generatePlan).
  agentId: z.string().optional(),

  input: z.record(
    z.string(),
    z.unknown(),
  ).default({}),

  maxRetries: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(2),

  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .default(120_000),

  sideEffect: z
    .boolean()
    .default(false),

  requiresApproval: z
    .boolean()
    .default(false),
});

export const DynamicPlanSchema = z.object({
  objective: z.string().min(3),

  reasoning: z.string().optional(),

  steps: z
    .array(PlannerStepSchema)
    .min(1)
    .max(100),

  maxConcurrency: z
    .number()
    .int()
    .min(1)
    .max(32)
    .default(4),

  maxIterations: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10),

  estimatedCredits: z
    .number()
    .nonnegative()
    .default(0),
});

export type DynamicPlan = z.infer<
  typeof DynamicPlanSchema
>;

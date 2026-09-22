import { z } from "zod";

export const RuntimeStepStatusSchema = z.enum(["pending","ready","running","completed","failed","cancelled","waiting_approval","skipped"]);
export type RuntimeStepStatus = z.infer<typeof RuntimeStepStatusSchema>;

export const RuntimeStepTypeSchema = z.enum(["llm","tool","research","document","media","code","condition"]);
export type RuntimeStepType = z.infer<typeof RuntimeStepTypeSchema>;

export const RuntimeStepSchema = z.object({
  id: z.string().min(1), type: RuntimeStepTypeSchema, name: z.string().min(1), description: z.string().min(1),
  dependencies: z.array(z.string()).default([]), status: RuntimeStepStatusSchema.default("pending"), input: z.record(z.string(), z.unknown()).default({}), output: z.unknown().optional(),
  toolName: z.string().optional(), skillIds: z.array(z.string()).default([]), maxRetries: z.number().int().min(0).max(10).default(2), timeoutMs: z.number().int().positive().max(120_000).default(120_000),
  sideEffect: z.boolean().default(false), requiresApproval: z.boolean().default(false), agentRole: z.string().min(1).optional(),
});
export type RuntimeStep = z.infer<typeof RuntimeStepSchema>;

export const RuntimePlanSchema = z.object({
  executionId: z.string().min(1), objective: z.string().min(1), steps: z.array(RuntimeStepSchema).min(1),
  maxConcurrency: z.number().int().positive().max(32).default(4), maxIterations: z.number().int().positive().max(50).default(10),
});
export type RuntimePlan = z.infer<typeof RuntimePlanSchema>;

export interface RuntimeObservation { stepId: string; success: boolean; output?: unknown; error?: string; latencyMs: number; timestamp: string; }
export interface RuntimeEvaluation { stepId: string; success: boolean; score: number; feedback: string; shouldRetry: boolean; correction?: string; }
export interface RuntimeBillingState {
  currency: string;
  totalChargeMinor: number;
  totalProviderCostEur: number;
  llmInputTokens: number;
  llmOutputTokens: number;
}
export interface RuntimeExecutionState {
  executionId: string; userId: string; objective: string; conversationId?: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "paused";
  plan: RuntimePlan; observations: RuntimeObservation[]; evaluations: RuntimeEvaluation[];
  outputs: Record<string, unknown>; iteration: number; totalRetries: number; maxTotalRetries: number;
  billing: RuntimeBillingState;
  startedAt?: string; completedAt?: string; error?: string;
}

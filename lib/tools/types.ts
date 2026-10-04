import type { z } from "zod";

export type ToolCategory = "web" | "browser" | "github" | "files" | "database" | "http" | "code" | "mcp" | "composio" | "media" | "system";
export type ToolRisk = "low" | "medium" | "high" | "critical";
export type ToolExecutionStatus = "success" | "failed" | "denied" | "timeout" | "cancelled";

export interface ToolContext {
  userId: string;
  projectId?: string;
  agentId?: string;
  executionId?: string;
  signal?: AbortSignal;
  metadata?: Record<string, string>;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  id?: string;
  name: string;
  description: string;
  category: ToolCategory;
  risk: ToolRisk;
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

export interface ToolCall {
  id: string;
  toolId: string;
  input: unknown;
  requestedAt: string;
}

export interface ToolResult {
  callId: string;
  toolId: string;
  status: ToolExecutionStatus;
  output?: unknown;
  error?: string;
  latencyMs: number;
  executedAt: string;
}

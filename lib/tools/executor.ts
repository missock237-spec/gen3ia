import { checkPermission, DEFAULT_PERMISSION_POLICY, type PermissionPolicy } from "./permission";
import { recordToolAudit } from "./audit";
import { ToolRegistry } from "./registry";
import { createDefaultToolRegistry } from "./default-registry";
import type { ToolCall, ToolContext, ToolResult } from "./types";
import { DEFAULT_EXECUTION_POLICY, type ExecutionPolicy } from "@/lib/security/execution-policy";
import { authorizeTool } from "@/lib/security/tool-permissions";
import { executeSandbox } from "@/lib/sandbox/client";
import type { SandboxLimits, SandboxRuntime } from "@/lib/sandbox/types";

export interface ToolApprovalService {
  requestApproval(params: { userId: string; toolId: string; input: unknown; reason: string }): Promise<boolean>;
}

export interface ExecuteToolRequest {
  userId: string;
  executionId: string;
  projectId?: string;
  toolName: string;
  input: unknown;
  signal?: AbortSignal;
  policy?: ExecutionPolicy;
}

const toolRegistry = createDefaultToolRegistry();
const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: 30_000,
  memoryMb: 512,
  cpu: 1,
  maxOutputBytes: 1_000_000,
};

function parseSandboxInput(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("code.execute input must be an object");
  const value = input as Record<string, unknown>;
  if (value.runtime !== "node" && value.runtime !== "python") throw new Error("Invalid sandbox runtime");
  if (typeof value.code !== "string" || value.code.length < 1 || value.code.length > 500_000) throw new Error("Invalid sandbox code");
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...(value.limits as Partial<SandboxLimits> | undefined) };
  if (!Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 100 || limits.timeoutMs > 120_000) throw new Error("Invalid sandbox timeout");
  if (!Number.isInteger(limits.memoryMb) || limits.memoryMb < 64 || limits.memoryMb > 2_048) throw new Error("Invalid sandbox memory limit");
  if (typeof limits.cpu !== "number" || limits.cpu < 0.1 || limits.cpu > 2) throw new Error("Invalid sandbox CPU limit");
  if (!Number.isInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1_024 || limits.maxOutputBytes > 10_000_000) throw new Error("Invalid sandbox output limit");
  return { runtime: value.runtime as SandboxRuntime, code: value.code, input: value.input, limits };
}

export async function executeTool(request: ExecuteToolRequest) {
  const policy = request.policy ?? DEFAULT_EXECUTION_POLICY;

  try {
    authorizeTool(policy, request.toolName);
    if (request.signal?.aborted) throw new Error("Execution cancelled");

    if (request.toolName === "code.execute") {
      const sandbox = parseSandboxInput(request.input);
      const result = await executeSandbox({
        executionId: request.executionId,
        userId: request.userId,
        runtime: sandbox.runtime,
        code: sandbox.code,
        input: sandbox.input,
        limits: sandbox.limits,
        network: "none",
      });
      return { success: true, output: result };
    }

    const tool = toolRegistry.get(request.toolName);
    if (!tool) return { success: false, error: `Unknown tool: ${request.toolName}` };
    const parsedInput = tool.inputSchema.parse(request.input);
    const output = await tool.execute(parsedInput, {
      userId: request.userId,
      executionId: request.executionId,
      projectId: request.projectId,
      signal: request.signal,
    });
    return { success: true, output };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Tool execution failed" };
  }
}

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly approvalService?: ToolApprovalService,
    private readonly policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
  ) {}

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    let result: ToolResult;
    try {
      const tool = this.registry.get(call.toolId);
      if (!tool) throw new Error(`Unknown tool: ${call.toolId}`);
      const permission = checkPermission(tool.risk, this.policy);
      if (!permission.allowed) {
        result = { callId: call.id, toolId: call.toolId, status: "denied", error: "Tool execution denied by policy.", latencyMs: Date.now() - startedAt, executedAt: new Date().toISOString() };
        await recordToolAudit({ ...context, toolId: call.toolId, input: call.input, result });
        return result;
      }
      if (permission.requiresApproval) {
        if (!this.approvalService) throw new Error("Human approval is required but no approval service is configured.");
        const approved = await this.approvalService.requestApproval({ userId: context.userId, toolId: call.toolId, input: call.input, reason: permission.reason });
        if (!approved) {
          result = { callId: call.id, toolId: call.toolId, status: "denied", error: "User denied the requested action.", latencyMs: Date.now() - startedAt, executedAt: new Date().toISOString() };
          await recordToolAudit({ ...context, toolId: call.toolId, input: call.input, result });
          return result;
        }
      }
      const parsedInput = tool.inputSchema.parse(call.input);
      const output = await tool.execute(parsedInput, context);
      result = { callId: call.id, toolId: call.toolId, status: "success", output, latencyMs: Date.now() - startedAt, executedAt: new Date().toISOString() };
    } catch (error) {
      result = { callId: call.id, toolId: call.toolId, status: "failed", error: error instanceof Error ? error.message : "Tool execution failed.", latencyMs: Date.now() - startedAt, executedAt: new Date().toISOString() };
    }
    await recordToolAudit({ ...context, toolId: call.toolId, input: call.input, result });
    return result;
  }
}

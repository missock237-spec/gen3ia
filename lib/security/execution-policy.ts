import { z } from "zod";

export const ToolRiskSchema = z.enum(["safe", "read", "write", "external", "destructive"]);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export const PermissionSchema = z.enum([
  "tool.read", "tool.write", "tool.external", "tool.destructive",
  "file.read", "file.write", "file.create", "file.delete",
  "network.read", "network.write", "code.execute", "terminal.execute",
  "camera.capture", "memory.read", "memory.write", "ads.read", "ads.write",
  "extension.execute",
]);
export type Permission = z.infer<typeof PermissionSchema>;

export interface ExecutionPolicy {
  allowedTools: string[];
  permissions: Permission[];
  maxSteps: number;
  maxExecutionMs: number;
  maxToolExecutionMs: number;
  maxOutputBytes: number;
  maxInputBytes: number;
  allowNetwork: boolean;
  allowExternalApps: boolean;
  allowFileWrite: boolean;
  allowFileDelete: boolean;
  allowCodeExecution: boolean;
  allowAgentTerminal: boolean;
  allowCamera: boolean;
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  allowedTools: [],
  permissions: ["tool.read", "file.read"],
  maxSteps: 120,
  maxExecutionMs: 30 * 60 * 1000,
  maxToolExecutionMs: 300 * 1000,
  maxOutputBytes: 25 * 1024 * 1024,
  maxInputBytes: 10 * 1024 * 1024,
  allowNetwork: false,
  allowExternalApps: false,
  allowFileWrite: false,
  allowFileDelete: false,
  allowCodeExecution: false,
  allowAgentTerminal: false,
  allowCamera: false,
};

export function hasPermission(policy: ExecutionPolicy, permission: Permission): boolean { return policy.permissions.includes(permission); }
export function isToolAllowed(policy: ExecutionPolicy, toolName: string): boolean { return policy.allowedTools.includes("*") || policy.allowedTools.includes(toolName); }
export function assertPermission(policy: ExecutionPolicy, permission: Permission): void {
  if (!hasPermission(policy, permission)) throw new Error(`Permission denied: ${permission}`);
}
export function assertToolAllowed(policy: ExecutionPolicy, toolName: string): void {
  if (!isToolAllowed(policy, toolName)) throw new Error(`Tool not allowed: ${toolName}`);
}

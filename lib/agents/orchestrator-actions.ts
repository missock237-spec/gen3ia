import type { ExecutionPolicy } from "@/lib/security/execution-policy";
import { DEFAULT_EXECUTION_POLICY } from "@/lib/security/execution-policy";
import type { AgentRole } from "./orchestrator";

/**
 * Builds the policy for actions that an orchestrator is explicitly allowed to
 * execute. Read-only orchestration remains the default. External side effects
 * are opt-in and must be accompanied by an explicit user confirmation at the
 * API/UI boundary.
 */
export function buildOrchestratorActionPolicy(options: {
  roles: AgentRole[];
  allowExternalActions: boolean;
  allowFileWrite?: boolean;
}): ExecutionPolicy {
  const allowedTools = ["web.search", "file.read"];
  const permissions = ["tool.read", "file.read", "network.read"] as ExecutionPolicy["permissions"];

  if (!options.allowExternalActions) {
    return {
      ...DEFAULT_EXECUTION_POLICY,
      allowedTools,
      permissions,
      allowNetwork: true,
      maxSteps: 100,
    };
  }

  allowedTools.push("composio.execute");
  permissions.push("tool.external", "tool.write", "network.write");

  return {
    ...DEFAULT_EXECUTION_POLICY,
    allowedTools,
    permissions,
    allowNetwork: true,
    allowExternalApps: true,
    allowFileWrite: options.allowFileWrite === true,
    maxSteps: 100,
  };
}

export function roleCanUseExternalActions(role: AgentRole): boolean {
  return ["customer_service", "sales", "content", "admin"].includes(role);
}

import { createHash } from "node:crypto";
import { getActionApproval } from "@/lib/agents/action-approvals";
import { getToolSecurityDefinition, isExtensionToolName } from "./tool-permissions";

export type AutonomyRisk = "low" | "medium" | "high" | "critical";

const MAX_APPROVAL_ARGUMENTS_BYTES = 100_000;
const EXTERNAL_MUTATION_TOOLS = new Set(["composio.execute", "ads.publish", "github.create_repository", "phone.call"]);
const CRITICAL_TOOLS = new Set(["ads.publish", "file.delete"]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function hashArguments(value: Record<string, unknown>): string {
  const json = JSON.stringify(canonicalize(value));
  if (json.length > MAX_APPROVAL_ARGUMENTS_BYTES) throw new Error("Action arguments exceed the autonomy safety limit.");
  return createHash("sha256").update(json).digest("hex");
}

export function getAutonomyRisk(toolName: string): AutonomyRisk {
  if (CRITICAL_TOOLS.has(toolName)) return "critical";
  if (EXTERNAL_MUTATION_TOOLS.has(toolName)) return "high";
  if (isExtensionToolName(toolName)) return "high";
  const definition = getToolSecurityDefinition(toolName);
  if (definition.risk === "destructive") return "high";
  if (definition.risk === "external") return "medium";
  if (definition.risk === "write") return "medium";
  return "low";
}

export function requiresPersistedApproval(toolName: string): boolean {
  return EXTERNAL_MUTATION_TOOLS.has(toolName) || CRITICAL_TOOLS.has(toolName) || isExtensionToolName(toolName);
}

export async function assertAutonomousActionAllowed(params: {
  userId: string;
  toolName: string;
  input: Record<string, unknown>;
  approvalId?: string;
}): Promise<void> {
  const risk = getAutonomyRisk(params.toolName);
  if (risk === "low" || (risk === "medium" && !requiresPersistedApproval(params.toolName))) return;
  if (!requiresPersistedApproval(params.toolName)) throw new Error("Human approval is required for high-risk tool: " + params.toolName);
  if (!params.approvalId) throw new Error("Human approval is required before executing " + params.toolName + ".");

  const approval = await getActionApproval(params.userId, params.approvalId);
  if (approval.status !== "executing") throw new Error("The persisted approval is not in an executable state.");

  if (params.toolName === "composio.execute") {
    if (!approval.toolSlug || approval.toolSlug !== params.input.toolSlug) throw new Error("The persisted approval does not match the requested external tool.");
    const approvedHash = hashArguments({ toolSlug: approval.toolSlug, arguments: approval.arguments });
    const requestedHash = hashArguments({ toolSlug: params.input.toolSlug, arguments: params.input.arguments });
    if (approvedHash !== requestedHash) throw new Error("The execution arguments do not match the approved action.");
    return;
  }

  if (isExtensionToolName(params.toolName)) {
    if (approval.toolSlug !== params.toolName) throw new Error("The persisted approval does not match the requested extension tool.");
    if (hashArguments(approval.arguments) !== hashArguments(params.input)) throw new Error("The extension execution arguments do not match the approved action.");
    return;
  }

  if (approval.toolSlug !== params.toolName) throw new Error("The persisted approval does not match the requested tool.");
  if (hashArguments(approval.arguments) !== hashArguments(params.input)) throw new Error("The execution arguments do not match the approved action.");
}

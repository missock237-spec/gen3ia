import { randomUUID } from "node:crypto";
import { generateForUser } from "@/lib/billing/ai-execution";
import type { AgentRole } from "./orchestrator";

export interface PlannedExternalAction {
  id: string;
  role: AgentRole;
  toolSlug: string;
  arguments: Record<string, unknown>;
  reason: string;
  requiresConfirmation: true;
}

const schema = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          role: { type: "string", enum: ["customer_service", "sales", "content", "admin"] },
          toolSlug: { type: "string" },
          arguments: { type: "object", additionalProperties: true },
          reason: { type: "string" },
        },
        required: ["id", "role", "toolSlug", "arguments", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["actions"],
  additionalProperties: false,
};

export async function planExternalActions(params: {
  userId: string;
  objective: string;
  roles: AgentRole[];
  context?: Record<string, unknown>;
  executionId?: string;
}): Promise<PlannedExternalAction[]> {
  const executionId = params.executionId ?? randomUUID();
  const billed = await generateForUser({
    userId: params.userId,
    executionId,
    complexity: 1.25,
    request: {
      task: "agent",
      maxTokens: 3072,
      requiresStructuredOutput: true,
      messages: [
        {
          role: "system",
          content: `You are Gen3ia's action planner. Produce ONLY proposed external application actions. Never claim an action was executed. Only use roles present in the supplied list. Actions must be safe to present for human confirmation. Never request passwords, API keys, tokens, cookies, recovery codes, payment credentials or secrets. Prefer drafts/read operations when possible. For Composio, toolSlug must be the exact connected Composio action slug known to the user; never invent a successful result. Return strict JSON matching this schema: ${JSON.stringify(schema)}`,
        },
        {
          role: "user",
          content: JSON.stringify({ objective: params.objective, roles: params.roles, context: params.context ?? {} }),
        },
      ],
    },
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(billed.response.text);
  } catch {
    throw new Error("Action planner returned invalid JSON");
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { actions?: unknown }).actions)) {
    throw new Error("Action planner returned an invalid action plan");
  }

  return (parsed as { actions: unknown[] }).actions.slice(0, 20).map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`Invalid external action at index ${index}`);
    const value = raw as Record<string, unknown>;
    if (typeof value.id !== "string" || !value.id.trim()) throw new Error(`External action ${index} has no id`);
    if (!params.roles.includes(value.role as AgentRole)) throw new Error(`External action ${value.id} uses an unauthorized role`);
    if (typeof value.toolSlug !== "string" || !value.toolSlug.trim()) throw new Error(`External action ${value.id} has no toolSlug`);
    if (!value.arguments || typeof value.arguments !== "object" || Array.isArray(value.arguments)) throw new Error(`External action ${value.id} has invalid arguments`);
    if (typeof value.reason !== "string" || !value.reason.trim()) throw new Error(`External action ${value.id} has no reason`);
    return {
      id: value.id.slice(0, 128),
      role: value.role as AgentRole,
      toolSlug: value.toolSlug.slice(0, 256),
      arguments: value.arguments as Record<string, unknown>,
      reason: value.reason.slice(0, 2000),
      requiresConfirmation: true as const,
    };
  });
}

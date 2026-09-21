import { randomUUID } from "node:crypto";

import { createAgentPolicy, type AgentSecurityLevel } from "@/lib/security/agent-policy";
import type { ExecutionPolicy } from "@/lib/security/execution-policy";
import type { RuntimePlan, RuntimeStep } from "@/lib/agents/runtime/types";

import { AGENT_TYPE_META, type AgentRecord } from "./schema";

/**
 * Traduit un agent personnalise (record Firestore) en plan d'execution concret
 * pour AgentRuntime, et derive sa politique de securite. Un agent cree et
 * personnalise via le Studio doit pouvoir s'executer immediatement.
 */

const ROLE_BY_TYPE: Record<string, string> = {
  universal: "general",
  code: "developer",
  content: "publisher",
  research: "researcher",
  automation: "planner",
};

const BASE_TOOLS_BY_LEVEL: Record<AgentSecurityLevel, string[]> = {
  safe: [],
  standard: ["web.search", "file.read", "file.create"],
  power: [
    "web.search",
    "file.read",
    "file.create",
    "file.modify",
    "zip.analyze",
    "zip.create",
    "zip.extract",
    "artifact.create",
    "code.execute",
  ],
  admin: ["*"],
};

export function securityLevelForAgent(agent: AgentRecord): AgentSecurityLevel {
  return AGENT_TYPE_META[agent.type]?.securityLevel ?? "standard";
}

export function policyForAgent(agent: AgentRecord): ExecutionPolicy {
  const level = securityLevelForAgent(agent);
  const base = createAgentPolicy(level);
  const declaredTools = agent.tools.filter((tool) => /^[a-z0-9_.]+$/.test(tool) && tool.length <= 80);
  // Capacités activables de la persona : désactiver une capacité retire les
  // outils correspondants de la whitelist, même s'ils étaient déclarés.
  const caps = agent.persona?.capabilities;
  const allowed = Array.from(new Set([...(base.allowedTools ?? []), ...declaredTools])).filter(
    // ui.components est l'outil EXCLUSIF des agents de type "code" : un autre
    // type d'agent ne peut pas l'obtenir en le declarant dans sa config.
    (tool) => tool !== "ui.components" || agent.type === "code",
  ).filter((tool) => {
    if (caps?.webSearch === false && tool === "web.search") return false;
    if (caps?.codeExecution === false && tool === "code.execute") return false;
    if (caps?.fileGeneration === false && tool === "artifact.create") return false;
    return true;
  });
  return {
    ...base,
    // Les outils declares par le proprietaire s'ajoutent a la whitelist de son
    // niveau. Ils restent soumis aux garde-fous (authorizeTool, approval,
    // metering) dans executeToolSecurely.
    allowedTools: allowed,
  };
}

function baseStep(partial: Omit<RuntimeStep, "status" | "skillIds" | "maxRetries" | "timeoutMs" | "sideEffect" | "requiresApproval" | "dependencies" | "input"> & {
  dependencies?: string[];
  input?: Record<string, unknown>;
}): RuntimeStep {
  return {
    dependencies: [],
    input: {},
    skillIds: [],
    maxRetries: 2,
    timeoutMs: 120_000,
    sideEffect: false,
    requiresApproval: false,
    status: "pending",
    ...partial,
  };
}

export function createPersonalizedPlan(agent: AgentRecord, objective: string, executionId = randomUUID()): RuntimePlan {
  const role = ROLE_BY_TYPE[agent.type] ?? "general";
  const steps: RuntimeStep[] = [];

  if (agent.webResearchEnabled) {
    steps.push(
      baseStep({
        id: "research_context",
        type: "research",
        name: "Collecte d'informations",
        description: "Rechercher les informations externes necessaires a l'objectif.",
        agentRole: "researcher",
        input: { query: objective },
      }),
    );
  }

  steps.push(
    baseStep({
      id: "deliver_result",
      type: "llm",
      name: "Execution de la mission",
      description: objective,
      agentRole: role,
      ...(steps.length > 0 ? { dependencies: [steps[0].id] } : {}),
    }),
  );

  return {
    executionId,
    objective,
    steps,
    maxConcurrency: steps.length > 1 ? 2 : 1,
    maxIterations: Math.min(agent.maxIterations, 20),
  };
}

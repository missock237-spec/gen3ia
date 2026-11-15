import { randomUUID } from "node:crypto";

import type { ExecutionPolicy } from "@/lib/security/execution-policy";
import { DEFAULT_EXECUTION_POLICY } from "@/lib/security/execution-policy";
import type { RuntimePlan, RuntimeStep } from "@/lib/agents/runtime/types";
import type { RuntimeAgentConfig } from "@/lib/agents/runtime/runner";
import { AgentRuntime } from "@/lib/agents/runtime/runner";

import type { NetworkView } from "./types";

/**
 * MISSION D'ÉQUIPE (concept #3 « Agent-as-a-Company ») : une mission lancée
 * à un réseau PERSISTANT d'agents, construite sur le runtime standard
 * (file d'attente, HITL, facturation, pause/arrêt, porte de résultat — tout
 * est hérité).
 *
 * Topologie « coordinator » : l'agent coordinateur reçoit l'objectif + la
 * composition de l'équipe et produit les AFFECTATIONS ; chaque membre est
 * ensuite exécuté comme VRAI sous-agent du Studio (sa charte, son modèle,
 * sa température) avec les affectations en contexte de dépendance — la
 * distribution est donc réelle, pas décorative.
 *
 * Topologie « peer » : chaque membre reçoit l'objectif + son rôle, en
 * parallèle ; la synthèse agrège sans hiérarchie.
 *
 * Garde-fous : sous-agents = membres réels et actifs (liste blanche stricte
 * du runtime), profondeur 1 (un membre ne redélègue pas), étapes membres
 * sans effet de bord (les actions sensibles restent des étapes HITL du plan
 * superviseur).
 */

const COORDINATOR_STEP_ID = "network-coordinator";
const SYNTHESIS_STEP_ID = "network-synthesis";

function memberStepId(agentId: string): string {
  return `network-member-${agentId}`;
}

/** Construit le plan d'exécution de la mission d'équipe (DAG valide). */
export function buildNetworkMissionPlan(input: {
  network: NetworkView;
  objective: string;
  executionId?: string;
}): RuntimePlan {
  const { network, objective } = input;
  const members = network.members;
  if (members.length === 0) throw new Error("Le réseau n'a aucun membre actif.");

  const roster = members
    .map((member) => `- agentId: ${member.agentId} | rôle: ${member.role}${member.department ? ` | département: ${member.department}` : ""}`)
    .join("\n");

  const steps: RuntimeStep[] = [];
  const memberStepIds: string[] = [];

  if (network.topology === "coordinator" && network.coordinatorAgentId) {
    // Étape 1 : le coordinateur (vrai sous-agent du Studio) distribue.
    // NB : executeSubAgent relaie la DESCRIPTION (pas step.input) — la
    // composition de l'équipe est donc portée par la description.
    steps.push({
      id: COORDINATOR_STEP_ID,
      type: "agent",
      name: `Coordination — ${network.name}`,
      description:
        `Coordonne l'équipe « ${network.name} » (topologie coordinateur) pour l'objectif : ${objective.slice(0, 1_200)}\n` +
        `COMPOSITION DE L'ÉQUIPE :\n${roster.slice(0, 2_400)}\n` +
        `Délivre UNIQUEMENT les affectations au format JSON : {"assignments": [{"agentId": "<id>", "task": "<tâche opérationnelle précise>"}]} — une entrée par membre ci-dessus, aucune autre.`,
      dependencies: [],
      status: "pending",
      input: { roster: roster.slice(0, 4_000) },
      skillIds: [],
      maxRetries: 2,
      timeoutMs: 120_000,
      sideEffect: false,
      requiresApproval: false,
      agentId: network.coordinatorAgentId,
    });
    for (const member of members) {
      memberStepIds.push(memberStepId(member.agentId));
      steps.push({
        id: memberStepId(member.agentId),
        type: "agent",
        name: `Rôle ${member.role}${member.department ? ` (${member.department})` : ""}`,
        description: `Exécute la tâche qui t'est affectée par le coordinateur pour ce rôle. Objectif global : ${objective.slice(0, 1_500)}`,
        dependencies: [COORDINATOR_STEP_ID],
        status: "pending",
        input: { role: member.role, ...(member.department ? { department: member.department } : {}) },
        skillIds: [],
        maxRetries: 2,
        timeoutMs: 120_000,
        sideEffect: false,
        requiresApproval: false,
        agentId: member.agentId,
      });
    }
  } else {
    // Topologie « peer » : tous les membres en parallèle sur leur rôle.
    for (const member of members) {
      memberStepIds.push(memberStepId(member.agentId));
      steps.push({
        id: memberStepId(member.agentId),
        type: "agent",
        name: `Rôle ${member.role}${member.department ? ` (${member.department})` : ""}`,
        description: `Contribue à l'objectif dans TON rôle (${member.role}${member.department ? `, ${member.department}` : ""}) : ${objective.slice(0, 1_500)}`,
        dependencies: [],
        status: "pending",
        input: { role: member.role, ...(member.department ? { department: member.department } : {}) },
        skillIds: [],
        maxRetries: 2,
        timeoutMs: 120_000,
        sideEffect: false,
        requiresApproval: false,
        agentId: member.agentId,
      });
    }
  }

  // Synthèse finale : agrège les contributions réelles.
  steps.push({
    id: SYNTHESIS_STEP_ID,
    type: "llm",
    name: "Synthèse d'équipe",
    description: `Synthétise les contributions de l'équipe pour l'objectif : ${objective.slice(0, 1_500)}`,
    dependencies: memberStepIds,
    status: "pending",
    input: { objective: objective.slice(0, 2_000), roster: roster.slice(0, 4_000) },
    skillIds: [],
    maxRetries: 2,
    timeoutMs: 120_000,
    sideEffect: false,
    requiresApproval: false,
    agentRole: "orchestrator",
  });

  return {
    executionId: input.executionId ?? randomUUID(),
    objective,
    steps,
    maxConcurrency: Math.min(8, Math.max(2, members.length)),
    maxIterations: Math.max(10, members.length + 6),
  };
}

/** Configuration runtime pour la mission d'équipe (liste blanche stricte). */
export function networkRuntimeAgentConfig(network: NetworkView): RuntimeAgentConfig {
  const coordinator = network.members.find((member) => member.agentId === network.coordinatorAgentId);
  const rosterBlock = network.members
    .map((member) => `- ${member.agentId} (${member.role}${member.department ? `, ${member.department}` : ""})`)
    .join("\n");
  return {
    name: coordinator ? `${coordinator.role} — ${network.name}` : `Équipe ${network.name}`,
    systemPrompt:
      `Tu pilotes l'équipe d'agents « ${network.name} ». Composition :\n${rosterBlock}\n` +
      (network.description ? `Contexte de l'équipe : ${network.description.slice(0, 1_000)}\n` : "") +
      "Chaque délégation s'adresse à UN membre pour SA tâche assignée.",
    subAgentIds: network.members.map((member) => member.agentId),
    ...(network.orgId ? { orgId: network.orgId } : {}),
  };
}

/** Politique d'exécution d'équipe : interne (pas de réseau ni fichier) — la mission d'équipe délègue, elle n'agit pas directement. */
export function networkExecutionPolicy(): ExecutionPolicy {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    allowedTools: ["memory.read", "memory.write", "network.list", "network.read_inbox", "network.send_message"],
    permissions: ["tool.read", "tool.write", "memory.read", "memory.write"],
    maxSteps: 60,
    maxExecutionMs: 30 * 60 * 1000,
    maxToolExecutionMs: 120 * 1000,
  };
}

/**
 * Lance la mission d'équipe DANS L'APPEL (les routes peuvent aussi l'enfiler
 * — le plan est un RuntimePlan standard, relais file = même chemin que
 * /api/agents/run).
 */
export async function runNetworkMission(input: {
  userId: string;
  network: NetworkView;
  objective: string;
  signal?: AbortSignal;
  batchDeadlineMs?: number;
  initialOutputs?: Record<string, unknown>;
}): Promise<import("@/lib/agents/runtime/types").RuntimeExecutionState> {
  const plan = buildNetworkMissionPlan({ network: input.network, objective: input.objective });
  const runtime = new AgentRuntime({
    userId: input.userId,
    objective: input.objective,
    plan,
    policy: networkExecutionPolicy(),
    agent: networkRuntimeAgentConfig(input.network),
    ...(input.network.orgId ? { orgId: input.network.orgId } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.batchDeadlineMs ? { batchDeadlineMs: input.batchDeadlineMs } : {}),
    ...(input.initialOutputs ? { initialOutputs: input.initialOutputs } : {}),
  });
  return runtime.run();
}

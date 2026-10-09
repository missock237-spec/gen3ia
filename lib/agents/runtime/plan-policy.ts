import "server-only";

import type { RuntimePlan } from "@/lib/agents/runtime/types";
import {
  DEFAULT_EXECUTION_POLICY,
  type ExecutionPolicy,
} from "@/lib/security/execution-policy";
import { getToolSecurityDefinition } from "@/lib/security/tool-permissions";
import { PROJECT_SERVICE_TOOLS } from "@/lib/agents/services/bridge";

/**
 * POLICY D'EXÉCUTION DÉRIVÉE DU PLAN (Task 114 — fix « Tool not allowed »).
 *
 * POURQUOI : les missions passées par la FILE QStash étaient exécutées avec
 * la policy PAR DÉFAUT (`allowedTools: []`) — chaque étape tool/research du
 * plan levait « Tool not allowed: … » et la mission échouait. Le chemin
 * synchrone (repli chat) construisait au contraire sa policy depuis le plan.
 * Cette fonction partage EXACTEMENT cette logique : les outils prévus par le
 * planificateur (déjà filtrés par les allowlists de l'agent à la
 * planification) sont autorisés, avec les permissions requises déduites des
 * définitions de sécurité des outils, plus les services de base du projet
 * (recherche, fichiers, artefacts, mémoire, knowledge) comme le chemin agent.
 *
 * La politique reste une GARDE-FOU : les barrières fines (authorizeTool,
 * permissions, HITL du secure-tool-executor) s'appliquent en aval, et les
 * outils destructifs/externes du plan portent déjà requiresApproval
 * (forceSensitiveToolFlags).
 */
export function buildPlanExecutionPolicy(plan: RuntimePlan): ExecutionPolicy {
  const planTools = [...new Set(
    plan.steps
      .filter((step) => step.type === "tool" || step.type === "research")
      .map((step) => step.toolName)
      .filter((name): name is string => Boolean(name))
      .concat(plan.steps.some((step) => step.type === "research") ? ["web.search"] : [])
      .concat(plan.steps.some((step) => step.type === "code") ? ["code.execute"] : []),
  )];

  const permissions = new Set<ExecutionPolicy["permissions"][number]>(["tool.read"]);
  let allowNetwork = false;
  let allowFileWrite = false;
  let allowFileDelete = false;
  let allowCodeExecution = false;
  let allowAgentTerminal = false;
  let allowCamera = false;
  let allowExternalApps = false;

  // Définitions de sécurité : UNIQUEMENT pour les outils du plan (les
  // services de base ci-dessous n'ont pas tous une définition — ex.
  // code.simulate — et suivent le comportement historique du chemin agent).
  for (const tool of planTools) {
    const definition = getToolSecurityDefinition(tool);
    for (const permission of definition.requiredPermissions) permissions.add(permission);
    if (definition.network) allowNetwork = true;
    if (definition.filesystemWrite) allowFileWrite = true;
    if (definition.destructive) allowFileDelete = true;
    if (tool === "code.execute") allowCodeExecution = true;
    if (tool === "terminal.execute") allowAgentTerminal = true;
    if (tool === "camera.capture") allowCamera = true;
    if (definition.externalApp) allowExternalApps = true;
  }

  return {
    ...DEFAULT_EXECUTION_POLICY,
    allowedTools: [...new Set([...planTools, ...PROJECT_SERVICE_TOOLS])],
    permissions: [...permissions],
    maxSteps: Math.max(50, plan.steps.length + 10),
    allowNetwork,
    allowFileWrite,
    allowFileDelete,
    allowCodeExecution,
    allowAgentTerminal,
    allowCamera,
    allowExternalApps,
  };
}

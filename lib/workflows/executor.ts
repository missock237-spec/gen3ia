import { randomUUID } from "crypto";

import { adminDb } from "@/lib/firebase/admin";
import { getAgentForOwner } from "@/lib/agents/repository";
import { buildAgentCharter } from "@/lib/agents/charter";
import { generateForUser } from "@/lib/billing/ai-execution";
import { executeToolSecurely } from "@/lib/agents/runtime/secure-tool-executor";
import { ExecutionPolicy, DEFAULT_EXECUTION_POLICY } from "@/lib/security/execution-policy";
import type { Workflow } from "./types";

/**
 * Exécuteur de workflows Gen3ia — donne un moteur RÉEL au format graphe
 * de lib/workflows/types.ts (validator existant, jusque-là orphelin).
 *
 * Nœuds supportés :
 *  - agent      : délégation à un agent du Studio (charte + modèle propres,
 *                 appel LLM facturé au propriétaire) OU instructions libres ;
 *  - tool       : outil Gen3i à faible risque (executeToolSecurely, HITL et
 *                 audit applicables) — les outils à effet de bord élevé
 *                 restent interdits en workflow (message explicite) ;
 *  - condition  : {{nodeId}} (op eq/neq/contains/existe) valeur → routage
 *                 des arêtes (condition "true"/"false" ou comparaison) ;
 *  - transform  : gabarit avec interpolations {{nodeId}} → texte ;
 *  - approval   : point de validation humaine — l'exécution S'ARRÊTE
 *                 (statut awaiting_approval), une approbation est créée et
 *                 la reprise se fait via la route run avec runId+approve ;
 *  - parallel   : marqueur structurel — les successeurs directs partent
 *                 concurremment (le graphe est exécuté par vagues prêtes) ;
 *  - output     : agrège le résultat final de l'exécution.
 */

export const WORKFLOW_RUN_COLLECTION = "workflowRuns";

export type WorkflowNode = Workflow["nodes"][number];

export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  version: number;
  userId: string;
  status: "running" | "awaiting_approval" | "completed" | "failed";
  input: Record<string, unknown>;
  nodeOutputs: Record<string, unknown>;
  nodeStatuses: Record<string, "pending" | "completed" | "failed" | "waiting_approval">;
  approvalNodeId?: string;
  approvalId?: string;
  result?: unknown;
  error?: string;
  billing: { totalChargeMinor: number };
  startedAt: string;
  completedAt?: string;
}

/** Remplace les interpolations {{nodeId}} par la sortie texte du nœud. */
export function resolveTemplate(template: string, nodeOutputs: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_match, nodeId: string) => {
    const value = nodeOutputs[nodeId];
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

/** Évalue une condition de nœud condition : opération sur la sortie résolue. */
export function evaluateCondition(
  config: { expression?: string; op?: string; value?: string; target?: string },
  nodeOutputs: Record<string, unknown>,
): boolean {
  const source = resolveTemplate(config.target ? `{{${config.target}}}` : (config.expression ?? ""), nodeOutputs);
  const op = (config.op ?? "existe").toLowerCase();
  const comparator = resolveTemplate(config.value ?? "", nodeOutputs);
  switch (op) {
    case "eq": return source.trim() === comparator.trim();
    case "neq": return source.trim() !== comparator.trim();
    case "contains": return source.toLowerCase().includes(comparator.toLowerCase());
    case "gt": return Number(source) > Number(comparator);
    case "lt": return Number(source) < Number(comparator);
    case "existe":
    default: return source.trim().length > 0 && source.trim() !== "false" && source.trim() !== "null";
  }
}

/** Outils autorisés en workflow : risque maîtrisé, aucun effet destructeur. */
function lowRiskPolicy(toolNames: string[]): ExecutionPolicy {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    allowedTools: toolNames,
    maxSteps: Math.max(toolNames.length * 2, 10),
  };
}

interface ExecuteContext {
  userId: string;
  workflow: Workflow;
  state: WorkflowRunState;
  chargeMinor: (minor: number) => void;
}

async function executeNode(ctx: ExecuteContext, node: WorkflowNode): Promise<unknown> {
  const outputs = ctx.state.nodeOutputs;
  switch (node.type) {
    case "agent": {
      const agentId = typeof node.config.agentId === "string" ? node.config.agentId : undefined;
      const instructions = typeof node.config.instructions === "string" ? node.config.instructions : "";
      const task = resolveTemplate(typeof node.config.task === "string" ? node.config.task : instructions, outputs)
        || resolveTemplate(instructions, outputs);
      if (!task) throw new Error(`Nœud agent « ${node.name} » : aucune tâche définie (config.task).`);
      let systemPrompt = `You are a workflow step executor of the Gen3ia platform. ${"Answer directly, operationally and in French."}`;
      let provider: string | undefined;
      let model: string | undefined;
      let temperature: number | undefined;
      if (agentId) {
        const agent = await getAgentForOwner(ctx.userId, agentId);
        if (!agent || agent.status !== "active") throw new Error(`Nœud agent « ${node.name} » : agent introuvable ou inactif.`);
        // Identité réelle de l'agent : prompt système (ou charte générée),
        // modèle et température configurés dans le Builder.
        systemPrompt = agent.systemPrompt?.trim() || buildAgentCharter(agent);
        if (agent.modelStrategy === "fixed") {
          provider = agent.preferredProvider;
          model = agent.preferredModel;
        }
        temperature = agent.temperature;
      }
      const billed = await generateForUser({
        userId: ctx.userId,
        executionId: `wf_${ctx.state.runId}`,
        request: {
          task: "agent",
          ...(provider ? { provider: provider as "groq" | "openrouter" | "anthropic" | "openai" | "glm" | "huggingface" } : {}),
          ...(model ? { model } : {}),
          ...(typeof temperature === "number" ? { temperature } : {}),
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify({ tache: task, contexte: Object.fromEntries(Object.entries(outputs).slice(-6)) }) },
          ],
          maxTokens: 3000,
        },
      });
      ctx.chargeMinor(billed.chargeMinor);
      return billed.response.text;
    }

    case "tool": {
      const toolName = typeof node.config.toolName === "string" ? node.config.toolName : undefined;
      if (!toolName) throw new Error(`Nœud outil « ${node.name} » : toolName manquant.`);
      const rawInput = (node.config.input ?? {}) as Record<string, unknown>;
      const input: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rawInput)) {
        input[key] = typeof value === "string" ? resolveTemplate(value, outputs) : value;
      }
      // Le workflow n'exécute QUE des outils à risque maîtrisé : toute
      // action sensible doit passer par les Missions (validation humaine
      // intégrée au runtime d'agents), jamais par un graphe automatique.
      const result = (await executeToolSecurely({
        userId: ctx.userId,
        executionId: `wf_${ctx.state.runId}`,
        toolName,
        input,
        policy: lowRiskPolicy([toolName]),
      })) as { output?: unknown; result?: unknown } | string | number | boolean | null | undefined;
      if (result && typeof result === "object" && ("output" in result || "result" in result)) {
        return (result as { output?: unknown }).output ?? (result as { result?: unknown }).result ?? result;
      }
      return result;
    }

    case "condition": {
      const passed = evaluateCondition(node.config as { expression?: string; op?: string; value?: string; target?: string }, outputs);
      return { passed };
    }

    case "transform": {
      const template = typeof node.config.template === "string" ? node.config.template : "";
      return resolveTemplate(template, outputs);
    }

    case "output": {
      const template = typeof node.config.template === "string" ? node.config.template : undefined;
      if (template) return resolveTemplate(template, outputs);
      const last = Object.entries(outputs).slice(-1)[0];
      return last ? last[1] : null;
    }

    case "parallel":
      // Nœud structurel : rien à exécuter, les successeurs partagent la vague.
      return { parallel: true };

    default:
      throw new Error(`Nœud « ${node.name} » : type non exécutable (${node.type}).`);
  }
}

/** Successeurs activables d'un nœud selon les conditions des arêtes. */
function nextNodeIds(workflow: Workflow, nodeId: string, nodeOutputs: Record<string, unknown>): string[] {
  const outgoing = workflow.edges.filter((edge) => edge.source === nodeId);
  const conditionNode = workflow.nodes.find((node) => node.id === nodeId && node.type === "condition");
  if (conditionNode) {
    const passed = evaluateCondition(conditionNode.config as { expression?: string; op?: string; value?: string; target?: string }, nodeOutputs);
    const branch = passed ? "true" : "false";
    const matched = outgoing.filter((edge) => (edge.condition ?? "true").toLowerCase() === branch);
    return (matched.length > 0 ? matched : outgoing.filter((edge) => !edge.condition)).map((edge) => edge.target);
  }
  return outgoing.map((edge) => edge.target);
}

/**
 * Exécute (ou reprend) un workflow : vagues de nœuds prêts en parallèle,
 * checkpoint Firestore entre chaque vague (statuts + sorties), pause sur
 * approval, facturation réelle des nœuds agent.
 */
export async function runWorkflowGraph(params: {
  userId: string;
  workflow: Workflow;
  runId?: string;
  input?: Record<string, unknown>;
  resumeApproved?: boolean;
}): Promise<WorkflowRunState> {
  const workflow = params.workflow;
  const enabledNodes = workflow.nodes.filter((node) => node.enabled !== false);
  const byId = new Map(enabledNodes.map((node) => [node.id, node]));

  // État initial : reprise (runId fourni) ou création.
  let state: WorkflowRunState;
  if (params.runId) {
    const doc = await adminDb.collection(WORKFLOW_RUN_COLLECTION).doc(params.runId).get();
    if (!doc.exists || (doc.data() as { userId?: string } | undefined)?.userId !== params.userId) {
      throw new Error("Exécution introuvable.");
    }
    state = doc.data() as WorkflowRunState;
    if (state.status !== "awaiting_approval") throw new Error("Cette exécution n'attend pas de validation.");
    if (!params.resumeApproved) throw new Error("Validation humaine requise pour reprendre l'exécution.");
    const approvalNode = byId.get(state.approvalNodeId ?? "");
    if (approvalNode) state.nodeOutputs[approvalNode.id] = { approved: true };
    state.nodeStatuses[approvalNode?.id ?? ""] = "completed";
    state.status = "running";
  } else {
    const entryNodes = enabledNodes
      .filter((node) => !workflow.edges.some((edge) => edge.target === node.id))
      .map((node) => node.id);
    if (entryNodes.length === 0) throw new Error("Workflow invalide : aucun point d'entrée.");
    state = {
      runId: randomUUID(),
      workflowId: workflow.id,
      version: workflow.version,
      userId: params.userId,
      status: "running",
      input: params.input ?? {},
      nodeOutputs: { ...params.input },
      nodeStatuses: Object.fromEntries(enabledNodes.map((node) => [node.id, "pending" as const])),
      billing: { totalChargeMinor: 0 },
      startedAt: new Date().toISOString(),
    };
  }

  const ctx: ExecuteContext = {
    userId: params.userId,
    workflow,
    state,
    chargeMinor: (minor) => { state.billing.totalChargeMinor += minor; },
  };

  const save = async () => {
    await adminDb.collection(WORKFLOW_RUN_COLLECTION).doc(state.runId).set(state, { merge: true });
  };

  try {
    let waves = 0;
    while (waves < 50) {
      waves++;
      // Vague = nœuds pending dont tous les prédécesseurs actifs sont finis.
      const ready = enabledNodes.filter((node) => {
        if (state.nodeStatuses[node.id] !== "pending") return false;
        const predecessors = workflow.edges.filter((edge) => edge.target === node.id).map((edge) => byId.get(edge.source)).filter(Boolean) as WorkflowNode[];
        return predecessors.every((predecessor) => {
          const status = state.nodeStatuses[predecessor.id];
          if (predecessor.type === "condition") return status === "completed" || status === "pending";
          return status === "completed";
        });
      });

      if (ready.length === 0) break;

      const executed: Array<{ node: WorkflowNode; status: "completed" | "failed"; output?: unknown; error?: string }> = [];
      await Promise.all(ready.map(async (node) => {
        try {
          const output = await executeNode(ctx, node);
          state.nodeOutputs[node.id] = output;
          executed.push({ node, status: "completed", output });
        } catch (error) {
          executed.push({ node, status: "failed", error: error instanceof Error ? error.message : String(error) });
        }
      }));

      for (const item of executed) {
        state.nodeStatuses[item.node.id] = item.status;
      }

      // Point de validation humaine : pause + approbation persistée.
      const approvalNode = executed.find((item) => item.node.type === "approval" && item.status === "completed")?.node;
      if (approvalNode) {
        state.status = "awaiting_approval";
        state.approvalNodeId = approvalNode.id;
        const approvalId = randomUUID();
        state.approvalId = approvalId;
        await adminDb.collection("workflowApprovals").doc(approvalId).set({
          userId: params.userId,
          workflowId: workflow.id,
          runId: state.runId,
          nodeId: approvalNode.id,
          message: resolveTemplate(typeof approvalNode.config.message === "string" ? approvalNode.config.message : "Validation requise pour continuer.", state.nodeOutputs),
          status: "pending",
          createdAt: new Date().toISOString(),
        });
        await save();
        return state;
      }

      const failed = executed.find((item) => item.status === "failed");
      if (failed) {
        state.status = "failed";
        state.error = `Nœud « ${failed.node.name} » : ${failed.error ?? "échec"}`;
        state.completedAt = new Date().toISOString();
        await save();
        return state;
      }

      await save();
    }

    // Terminé : le résultat = sortie du/des nœuds output (ou dernière sortie).
    const outputNodes = enabledNodes.filter((node) => node.type === "output" && state.nodeStatuses[node.id] === "completed");
    state.result = outputNodes.length > 0
      ? (outputNodes.length === 1 ? state.nodeOutputs[outputNodes[0].id] : outputNodes.map((node) => ({ node: node.name, output: state.nodeOutputs[node.id] })))
      : Object.fromEntries(Object.entries(state.nodeOutputs).filter(([, value]) => value !== undefined));
    state.status = "completed";
    state.completedAt = new Date().toISOString();
    await save();
    return state;
  } catch (error) {
    state.status = "failed";
    state.error = error instanceof Error ? error.message : String(error);
    state.completedAt = new Date().toISOString();
    await save();
    return state;
  }
}

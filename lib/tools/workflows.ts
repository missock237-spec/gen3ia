import { z } from "zod";
import { randomUUID } from "crypto";

import { adminDb } from "@/lib/firebase/admin";
import type { ToolDefinition } from "@/lib/tools/types";
import { validateWorkflow } from "@/lib/workflows/validator";
import type { Workflow } from "@/lib/workflows/types";

/**
 * IMPORT DYNAMIQUE (casse-cycle) : lib/workflows/executor importe le runtime
 * agent qui importe l'exécuteur d'outils qui importe CE module.
 */
async function chargerExecuteur() {
  return import("@/lib/workflows/executor");
}

type WorkflowNode = Workflow["nodes"][number];
type WorkflowEdge = Workflow["edges"][number];

/**
 * Outils « workflows » : ils créent et exécutent des RÉELS graphes de
 * travail (collection Firestore `workflows`, moteur lib/workflows/executor,
 * nœuds agent/tool/condition/approval/transform/output). Un utilisateur peut
 * ainsi mettre en place une automatisation multi-étapes depuis la
 * conversation ou son agent IA, en langage naturel.
 *
 * Le graphe construit est linéaire et honnête : un nœud « agent » par étape
 * décrite (la tâche = la description donnée par l'utilisateur), chaînés dans
 * l'ordre, puis un nœud « output » qui agrège le résultat. Aucune étape
 * inventée : ce qui est en base est exactement ce qui a été demandé.
 */

const stepsSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().min(1).max(2000),
    }),
  )
  .min(1)
  .max(12);

const CreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  objective: z.string().trim().max(2000).optional(),
  steps: stepsSchema,
  /** Exécute le workflow immédiatement après sa création. */
  runNow: z.boolean().optional(),
  /** Données d'entrée initiales quand runNow (disponibles via {{input.<clé>}}). */
  input: z.record(z.string(), z.unknown()).optional(),
});

const ListInputSchema = z.object({});

const RunInputSchema = z.object({
  workflowId: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});

const WORKFLOW_COLLECTION = "workflows";

interface WorkflowDocMeta {
  id: string;
  name: string;
  nodeCount: number;
  version: number;
  updatedAt?: string;
}

/** Construit un graphe linéaire réel à partir des étapes décrites. */
export function construireGrapheLineaire(
  name: string,
  steps: Array<{ name: string; description: string }>,
): Workflow {
  const nodes: WorkflowNode[] = steps.map((step, index) => ({
    id: `step_${index + 1}`,
    type: "agent",
    name: step.name.slice(0, 80),
    config: {
      task: step.description,
    },
    position: { x: 80 + index * 240, y: 120 },
    enabled: true,
  }));
  const outputIndex = steps.length;
  nodes.push({
    id: "output_final",
    type: "output",
    name: "Résultat final",
    config: {},
    position: { x: 80 + outputIndex * 240, y: 120 },
    enabled: true,
  });
  const edges: WorkflowEdge[] = [];
  for (let i = 0; i < outputIndex; i++) {
    edges.push({
      id: `e_${i + 1}`,
      source: `step_${i + 1}`,
      target: i + 1 < outputIndex ? `step_${i + 2}` : "output_final",
    });
  }
  return { id: "probe", name, version: 1, nodes, edges };
}

/** Crée le document workflow (mêmes règles que POST /api/workflows). */
async function persisterWorkflow(
  userId: string,
  workflow: Workflow,
): Promise<WorkflowDocMeta> {
  const validation = validateWorkflow(workflow);
  if (!validation.valid) {
    throw new Error(`Workflow invalide : ${validation.errors.join(" | ")}`);
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  await adminDb.collection(WORKFLOW_COLLECTION).doc(id).set({
    ...workflow,
    id,
    version: 1,
    userId,
    createdAt: now,
    updatedAt: now,
  } as Record<string, unknown>);
  return { id, name: workflow.name, nodeCount: workflow.nodes.length, version: 1, updatedAt: now };
}

async function listerWorkflows(userId: string): Promise<WorkflowDocMeta[]> {
  const snapshot = await adminDb
    .collection(WORKFLOW_COLLECTION)
    .where("userId", "==", userId)
    .limit(50)
    .get();
  return snapshot.docs
    .map((doc) => {
      const data = doc.data() as { name?: string; nodes?: unknown[]; updatedAt?: string };
      return {
        id: doc.id,
        name: data.name ?? "(sans nom)",
        nodeCount: Array.isArray(data.nodes) ? data.nodes.length : 0,
        version: 1,
        updatedAt: data.updatedAt,
      };
    })
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

async function trouverWorkflow(
  userId: string,
  target: { workflowId?: string; name?: string },
): Promise<Workflow & { userId: string }> {
  if (target.workflowId) {
    const doc = await adminDb.collection(WORKFLOW_COLLECTION).doc(target.workflowId).get();
    const data = doc.data() as (Workflow & { userId: string }) | undefined;
    if (doc.exists && data?.userId === userId) return data;
  }
  if (target.name?.trim()) {
    const workflows = await listerWorkflows(userId);
    const needle = target.name.trim().toLowerCase();
    const match = workflows.find((w) => w.name.toLowerCase().includes(needle) || needle.includes(w.name.toLowerCase()));
    if (match) {
      const doc = await adminDb.collection(WORKFLOW_COLLECTION).doc(match.id).get();
      const data = doc.data() as (Workflow & { userId: string }) | undefined;
      if (data) return data;
    }
  }
  throw new Error("Workflow introuvable. Consultez vos workflows (workflow.list) pour retrouver le nom exact.");
}

export const workflowCreateTool: ToolDefinition<z.infer<typeof CreateInputSchema>> = {
  name: "workflow.create",
  description:
    "Crée un RÉEL workflow (graphe d'automatisation multi-étapes exécutable) : un nœud agent par étape, chaînés dans l'ordre. " +
    'Input : { name: "<nom du workflow>", steps: [{ name: "<étape>", description: "<tâche précise de l\'agent pour cette étape>" }], objective?, runNow?: boolean, input? }. ' +
    "runNow=true exécute le graphe immédiatement (facturé au compte, points de validation humaine respectés).",
  category: "system",
  risk: "medium",
  inputSchema: CreateInputSchema,
  async execute(input, context) {
    const workflow = construireGrapheLineaire(input.name, input.steps);
    const meta = await persisterWorkflow(context.userId, { ...workflow, name: input.name });
    let run: Record<string, unknown> | undefined;
    if (input.runNow === true) {
      const { runWorkflowGraph } = await chargerExecuteur();
      const state = await runWorkflowGraph({
        userId: context.userId,
        workflow: { ...workflow, id: meta.id, name: input.name },
        ...(input.input ? { input: input.input } : {}),
      });
      run = {
        runId: state.runId,
        status: state.status,
        ...(state.result !== undefined ? { result: state.result } : {}),
        ...(state.error ? { error: state.error } : {}),
      };
    }
    return {
      created: true,
      id: meta.id,
      name: input.name,
      nodeCount: meta.nodeCount,
      steps: input.steps.map((s) => s.name),
      ...(input.runNow === true ? { run } : {}),
    };
  },
};

export const workflowListTool: ToolDefinition<z.infer<typeof ListInputSchema>> = {
  name: "workflow.list",
  description: "Liste les RÉELS workflows du compte (nom, nombre de nœuds, dernière mise à jour).",
  category: "system",
  risk: "low",
  inputSchema: ListInputSchema,
  async execute(_input, context) {
    const workflows = await listerWorkflows(context.userId);
    return { count: workflows.length, workflows: workflows.slice(0, 20) };
  },
};

export const workflowRunTool: ToolDefinition<z.infer<typeof RunInputSchema>> = {
  name: "workflow.run",
  description:
    "Exécute RÉELLEMENT un workflow existant (graphe complet, facturé au compte ; les nœuds approval mettent l'exécution en attente de validation humaine). " +
    'Input : { workflowId? ou name? (ciblage), input?: {…} }. ' +
    "Utilisez d'abord workflow.list pour retrouver l'identifiant exact.",
  category: "system",
  risk: "medium",
  inputSchema: RunInputSchema,
  async execute(input, context) {
    const { runWorkflowGraph } = await chargerExecuteur();
    const workflow = await trouverWorkflow(context.userId, input);
    const state = await runWorkflowGraph({
      userId: context.userId,
      workflow,
      ...(input.input ? { input: input.input } : {}),
    });
    return {
      runId: state.runId,
      status: state.status,
      workflow: { id: workflow.id, name: workflow.name },
      ...(state.result !== undefined ? { result: state.result } : {}),
      ...(state.error ? { error: state.error } : {}),
    };
  },
};

const DeleteInputSchema = z.object({
  workflowId: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(120).optional(),
});

export const workflowDeleteTool: ToolDefinition<z.infer<typeof DeleteInputSchema>> = {
  name: "workflow.delete",
  description:
    "Supprime DÉFINITIVEMENT un workflow existant. Action sensible : validation humaine requise. " +
    "Input : { workflowId? ou name? (ciblage) }.",
  category: "system",
  risk: "high",
  inputSchema: DeleteInputSchema,
  async execute(input, context) {
    const workflow = await trouverWorkflow(context.userId, input);
    await adminDb.collection(WORKFLOW_COLLECTION).doc(workflow.id).delete();
    return { deleted: true, id: workflow.id, name: workflow.name };
  },
};

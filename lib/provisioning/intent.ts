import { z } from "zod";
import { randomUUID } from "crypto";

import { generate } from "@/lib/ai/router";
import { buildQuickCreatePayload } from "@/lib/agents/quick-create";
import { createAgentRecord } from "@/lib/agents/repository";
import { createDeveloperProject } from "@/lib/developer/projects";
import { validateWorkflow } from "@/lib/workflows/validator";
import { adminDb } from "@/lib/firebase/admin";

/**
 * PIPELINE INTENT → INFRASTRUCTURE (concept post-SaaS #4 « Intent-to-
 * Infrastructure ») : l'utilisateur décrit son besoin en UNE phrase, le
 * système construit le reste — classification de l'intention, puis mise en
 * place RÉELLE des ressources (agent du Studio, graphe de workflow, tâche
 * planifiée, projet) via les dépôts existants. Aucune ressource fantôme :
 * chaque provision crée un objet réel, listable et exécutable.
 *
 * `dryRun` retourne la proposition SANS exécution (l'utilisateur garde la
 * main). Le classificateur échoue honnêtement (erreur explicite) plutôt que
 * de créer une ressource aléatoire.
 */

const INTENT_KINDS = ["agent", "workflow", "schedule", "project", "unknown"] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

const CLASSIFIER_SYSTEM =
  "Tu es le provisionneur Gen3ia. L'utilisateur décrit un besoin en langage naturel. " +
  "Classe l'intention dans UN type et prépare les paramètres de mise en place :\n" +
  '- "agent" : un agent du Studio (name, description, typeKey parmi "code"|"marketing"|"teaching"|"sales"|"voice"|"custom", customType si custom) ;\n' +
  '- "workflow" : une automatisation multi-étapes (name, steps: [{name, description}] — 2 à 12 étapes séquentielles concrètes) ;\n' +
  '- "schedule" : une exécution récurrente d\'agent (objective, name?, daysOfWeek? [0=dimanche..6], startTime? "09:00", endTime?, intervalMinutes?) ;\n' +
  '- "project" : un projet de développement (name, description?, framework? "nextjs") ;\n' +
  '- "unknown" : besoin hors périmètre de provisionnement.\n' +
  'Réponds UNIQUEMENT en JSON : { "kind": string, "reasoning": string, "params": object }. ' +
  "Ne crée jamais de paramètres inventés : tout champ inconnu est omis.";

const ClassifierOutputSchema = z.object({
  kind: z.enum(INTENT_KINDS),
  reasoning: z.string().max(600).default(""),
  params: z.record(z.string(), z.unknown()).default({}),
});

function extractJsonCandidate(raw: string): unknown {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1]?.trim(), text].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(candidate.slice(start, end + 1));
        } catch {
          /* candidat suivant */
        }
      }
    }
  }
  throw new Error("Classification de l'intention non structurée (JSON attendu).");
}

export interface IntentClassification {
  kind: IntentKind;
  reasoning: string;
  params: Record<string, unknown>;
}

/** Classification LLM de l'intention (bornée, échec explicite). */
export async function classifyIntent(objective: string): Promise<IntentClassification> {
  const response = await generate({
    task: "reasoning",
    messages: [
      { role: "system", content: CLASSIFIER_SYSTEM },
      { role: "user", content: objective.slice(0, 2_000) },
    ],
    maxTokens: 900,
  });
  const parsed = ClassifierOutputSchema.parse(extractJsonCandidate(response.text));
  return { kind: parsed.kind, reasoning: parsed.reasoning, params: parsed.params };
}

/* ------------------------------------------------------------------ */
/* Provisionnement par type                                             */
/* ------------------------------------------------------------------ */

export interface ProvisionedResource {
  kind: "agent" | "workflow" | "schedule" | "project";
  id: string;
  name: string;
  detail: string;
}

/** Description NORMALISÉE de la mise en place (dry-run + réponse). */
export interface ProvisionPlan {
  kind: IntentKind;
  reasoning: string;
  /** Action exécutée ou à exécuter, lisible. */
  action: string;
  params: Record<string, unknown>;
}

async function provisionAgent(userId: string, params: Record<string, unknown>, orgId?: string): Promise<ProvisionedResource> {
  const name = typeof params.name === "string" && params.name.trim() ? params.name.trim().slice(0, 80) : "Agent provisionné";
  const typeKey = typeof params.typeKey === "string" ? params.typeKey : "custom";
  const customType = typeof params.customType === "string" ? params.customType.slice(0, 60) : undefined;
  const payload = buildQuickCreatePayload({ name, typeKey, ...(customType ? { customType } : {}) });
  const record = await createAgentRecord(
    userId,
    {
      ...payload,
      description: typeof params.description === "string" && params.description.trim() ? params.description.trim().slice(0, 500) : payload.description,
    },
    { orgId },
  );
  return { kind: "agent", id: record.id, name: record.name, detail: `Agent « ${record.name} » créé au Studio (type ${record.typeLabel ?? payload.typeLabel}).` };
}

/** Construit et persiste un graphe de workflow linéaire (mêmes règles que POST /api/workflows). */
async function provisionWorkflow(userId: string, params: Record<string, unknown>): Promise<ProvisionedResource> {
  const name = typeof params.name === "string" && params.name.trim() ? params.name.trim().slice(0, 120) : "Automatisation provisionnée";
  const rawSteps = Array.isArray(params.steps) ? params.steps : [];
  const steps = rawSteps
    .map((step) => (step && typeof step === "object" ? step as Record<string, unknown> : null))
    .filter((step): step is Record<string, unknown> => step !== null)
    .map((step) => ({
      name: typeof step.name === "string" ? step.name.trim().slice(0, 120) : "",
      description: typeof step.description === "string" ? step.description.trim().slice(0, 2_000) : "",
    }))
    .filter((step) => step.name && step.description)
    .slice(0, 12);
  if (steps.length < 2) throw new Error("Workflow : au moins deux étapes nommées + décrites sont nécessaires.");

  const nodes: Array<Record<string, unknown>> = steps.map((step, index) => ({
    id: `step_${index + 1}`,
    type: "agent",
    name: step.name,
    enabled: true,
    config: { task: step.description },
  }));
  const outputNodeId = `output_${randomUUID().slice(0, 8)}`;
  nodes.push({ id: outputNodeId, type: "output", name: "Résultat", enabled: true, config: {} });
  const edges = steps.map((_, index) => ({
    id: `e_${index + 1}`,
    source: `step_${index + 1}`,
    target: index + 1 < steps.length ? `step_${index + 2}` : outputNodeId,
  }));

  const workflow = { id: randomUUID(), name, version: 1, nodes, edges };
  const validation = validateWorkflow(workflow as unknown as Parameters<typeof validateWorkflow>[0]);
  if (!validation.valid) throw new Error(`Workflow invalide : ${validation.errors.join(" | ")}`);

  const now = new Date().toISOString();
  await adminDb.collection("workflows").doc(workflow.id).set({
    ...workflow,
    userId,
    createdAt: now,
    updatedAt: now,
  });
  return { kind: "workflow", id: workflow.id, name, detail: `Automatisation « ${name} » créée : ${steps.length} étapes séquentielles.` };
}

async function provisionSchedule(userId: string, params: Record<string, unknown>): Promise<ProvisionedResource> {
  const { scheduleCreateTool } = await import("@/lib/tools/schedules");
  const objective = typeof params.objective === "string" && params.objective.trim() ? params.objective.trim().slice(0, 2_000) : "";
  if (!objective) throw new Error("Planification : l'objectif récurrent est requis.");
  const rawDays = Array.isArray(params.daysOfWeek) ? params.daysOfWeek : undefined;
  const daysOfWeek = rawDays?.map((day) => Number(day)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  const result = await scheduleCreateTool.execute(
    {
      objective,
      ...(typeof params.name === "string" && params.name.trim() ? { name: params.name.trim().slice(0, 120) } : {}),
      ...(daysOfWeek && daysOfWeek.length > 0 ? { daysOfWeek } : {}),
      ...(typeof params.startTime === "string" ? { startTime: params.startTime } : {}),
      ...(typeof params.endTime === "string" ? { endTime: params.endTime } : {}),
      ...(typeof params.intervalMinutes === "number" ? { intervalMinutes: params.intervalMinutes } : {}),
    },
    { userId, executionId: randomUUID() },
  );
  const created = result as { schedule?: { id?: string } };
  return { kind: "schedule", id: created.schedule?.id ?? "", name: objective.slice(0, 80), detail: `Tâche planifiée créée : ${objective.slice(0, 120)}` };
}

async function provisionProject(userId: string, params: Record<string, unknown>): Promise<ProvisionedResource> {
  const name = typeof params.name === "string" && params.name.trim() ? params.name.trim().slice(0, 100) : "";
  if (!name) throw new Error("Projet : le nom est requis.");
  const project = await createDeveloperProject(userId, {
    name,
    ...(typeof params.description === "string" ? { description: params.description } : {}),
    ...(typeof params.framework === "string" ? { framework: params.framework } : {}),
  });
  return { kind: "project", id: project.id, name: project.name, detail: `Projet « ${project.name} » créé (environnement development).` };
}

export interface ProvisionResult {
  plan: ProvisionPlan;
  /** Présent si exécuté (dryRun=false) et le type est provisionnable. */
  resource?: ProvisionedResource;
  executed: boolean;
}

/**
 * Pipeline complet : classification → (exécution) → rapport. `unknown` est
 * une RÉPONSE (pas une erreur) : le système ne crée jamais une ressource
 * hasardeuse.
 */
export async function provisionFromIntent(input: {
  userId: string;
  orgId?: string;
  objective: string;
  dryRun?: boolean;
}): Promise<ProvisionResult> {
  const classification = await classifyIntent(input.objective);
  const plan: ProvisionPlan = {
    kind: classification.kind,
    reasoning: classification.reasoning,
    action:
      classification.kind === "agent"
        ? "Créer un agent au Studio depuis la création simplifiée (tout déduit du type)."
        : classification.kind === "workflow"
          ? "Créer une automatisation multi-étapes (graphe linéaire agent → sortie)."
          : classification.kind === "schedule"
            ? "Créer une tâche planifiée exécutée par un agent résolu automatiquement."
            : classification.kind === "project"
              ? "Créer un projet de développement."
              : "Aucun provisionnement : le besoin ne correspond à aucune ressource automatisable — reformulez (agent, automatisation, planification ou projet).",
    params: classification.params,
  };

  if (input.dryRun || classification.kind === "unknown") {
    return { plan, executed: false };
  }

  switch (classification.kind) {
    case "agent":
      return { plan, executed: true, resource: await provisionAgent(input.userId, classification.params, input.orgId) };
    case "workflow":
      return { plan, executed: true, resource: await provisionWorkflow(input.userId, classification.params) };
    case "schedule":
      return { plan, executed: true, resource: await provisionSchedule(input.userId, classification.params) };
    case "project":
      return { plan, executed: true, resource: await provisionProject(input.userId, classification.params) };
  }
}

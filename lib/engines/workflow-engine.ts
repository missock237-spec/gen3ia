import "server-only";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { createRecord, updateRecord } from "./data-engine";
import { createEvent } from "./scheduling-engine";
import { runAI } from "./ai-engine";
import { getAtPath } from "./analytics-engine";
import { BUSINESS_EVENT_TYPES, epochNow, type BusinessEventInput, type BusinessEventType } from "./types";

/**
 * Moteur 3 — Workflow Engine.
 *
 * Automatisations de l'utilisateur : un workflow = un déclencheur (manuel
 * ou événement métier), des conditions optionnelles et une séquence d'étapes
 * exécutées dans l'ordre. Chaque exécution est journalisée dans
 * `automationRuns` (statut par étape, sorties, erreurs) — consultable dans
 * le module Automatisations.
 *
 * Étapes disponibles (toutes bornées, aucune exécution de code arbitraire) :
 *  - ai_text        : rédaction/résumé via AI Engine (prompt avec placeholders)
 *  - create_event   : événement de calendrier via Scheduling Engine
 *  - create_record  : enregistrement métier via Data Engine
 *  - update_record  : mise à jour d'un enregistrement via Data Engine
 *  - notification   : notification in-app (collection businessNotifications)
 *
 * Interpolation : `{{payload.client}}`, `{{results.step1}}`, `{{workflow.name}}`
 * — fonction `interpolate` pure et testée. Conditions : comparaisons simples
 * sur le contexte, `evaluateConditions` pure et testée.
 */

export const WORKFLOW_COLLECTION = "automationWorkflows";
export const RUNS_COLLECTION = "automationRuns";
export const NOTIFICATIONS_COLLECTION = "businessNotifications";

/* ------------------------------------------------------------------ */
/* Schémas                                                            */
/* ------------------------------------------------------------------ */

export const WorkflowTriggerSchema = z.object({
  type: z.enum(["manual", "event"]),
  eventType: z.enum(BUSINESS_EVENT_TYPES).optional(),
}).refine((t) => t.type === "manual" || Boolean(t.eventType), { message: "eventType requis pour un déclencheur événement." });

export const WorkflowConditionSchema = z.object({
  field: z.string().min(1).max(120),
  op: z.enum(["eq", "neq", "gt", "lt", "gte", "lte", "contains"]),
  value: z.union([z.string().max(500), z.number(), z.boolean()]),
});

export const WorkflowStepSchema = z.object({
  id: z.string().min(1).max(60).regex(/^[a-zA-Z0-9_-]+$/, "Identifiant d'étape alphanumérique requis."),
  name: z.string().trim().min(1).max(120),
  type: z.enum(["ai_text", "create_event", "create_record", "update_record", "notification"]),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const BusinessWorkflowSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1_000).optional(),
  enabled: z.boolean().default(true),
  trigger: WorkflowTriggerSchema,
  conditions: z.array(WorkflowConditionSchema).max(10).default([]),
  steps: z.array(WorkflowStepSchema).min(1).max(12),
});

export type BusinessWorkflowInput = z.input<typeof BusinessWorkflowSchema>;

export interface BusinessWorkflow {
  id: string;
  userId: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: z.infer<typeof WorkflowTriggerSchema>;
  conditions: z.infer<typeof WorkflowConditionSchema>[];
  steps: z.infer<typeof WorkflowStepSchema>[];
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  runCount: number;
}

export interface WorkflowRunStep {
  stepId: string;
  name: string;
  type: string;
  status: "success" | "skipped" | "failed";
  output?: string;
  error?: string;
}

export interface WorkflowRun {
  id: string;
  userId: string;
  workflowId: string;
  workflowName: string;
  trigger: string;
  status: "success" | "partial" | "failed" | "skipped";
  steps: WorkflowRunStep[];
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

/* ------------------------------------------------------------------ */
/* Fonctions pures (testées)                                          */
/* ------------------------------------------------------------------ */

/** Interpolation `{{chemin.valeur}}` depuis un contexte arbitraire. */
export function interpolate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, path: string) => {
    const value = getAtPath(context, path);
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

/** Interpole récursivement toutes les chaînes d'une structure de config. */
export function interpolateConfig<T>(config: T, context: Record<string, unknown>): T {
  if (typeof config === "string") return interpolate(config, context) as unknown as T;
  if (Array.isArray(config)) return config.map((item) => interpolateConfig(item, context)) as unknown as T;
  if (config && typeof config === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) out[key] = interpolateConfig(value, context);
    return out as unknown as T;
  }
  return config;
}

/** Évalue les conditions du workflow sur le contexte (ET logique). */
export function evaluateConditions(
  conditions: Array<{ field: string; op: string; value: string | number | boolean }>,
  context: Record<string, unknown>,
): boolean {
  return conditions.every((condition) => {
    const actual = getAtPath(context, condition.field);
    const expected = condition.value;
    switch (condition.op) {
      case "eq":
        return String(actual) === String(expected);
      case "neq":
        return String(actual) !== String(expected);
      case "contains":
        return String(actual ?? "").toLowerCase().includes(String(expected).toLowerCase());
      case "gt":
        return Number(actual) > Number(expected);
      case "lt":
        return Number(actual) < Number(expected);
      case "gte":
        return Number(actual) >= Number(expected);
      case "lte":
        return Number(actual) <= Number(expected);
      default:
        return false;
    }
  });
}

/* ------------------------------------------------------------------ */
/* CRUD                                                               */
/* ------------------------------------------------------------------ */

export async function createWorkflow(userId: string, input: BusinessWorkflowInput): Promise<BusinessWorkflow> {
  const parsed = BusinessWorkflowSchema.parse(input);
  const now = epochNow();
  const ref = adminDb.collection(WORKFLOW_COLLECTION).doc();
  const workflow: BusinessWorkflow = {
    id: ref.id,
    userId,
    ...parsed,
    conditions: parsed.conditions ?? [],
    steps: parsed.steps,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
  };
  await ref.set(workflow);
  return workflow;
}

export async function listWorkflows(userId: string): Promise<BusinessWorkflow[]> {
  const snap = await adminDb
    .collection(WORKFLOW_COLLECTION)
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  return snap.docs.map((doc) => doc.data() as BusinessWorkflow);
}

export async function getWorkflow(userId: string, workflowId: string): Promise<BusinessWorkflow | null> {
  const snap = await adminDb.collection(WORKFLOW_COLLECTION).doc(workflowId).get();
  if (!snap.exists) return null;
  const workflow = snap.data() as BusinessWorkflow;
  return workflow.userId === userId ? workflow : null;
}

export async function updateWorkflow(
  userId: string,
  workflowId: string,
  patch: Partial<Pick<BusinessWorkflow, "name" | "description" | "enabled" | "conditions" | "steps" | "trigger">>,
): Promise<BusinessWorkflow> {
  const existing = await getWorkflow(userId, workflowId);
  if (!existing) throw new Error("Automatisation introuvable.");
  const now = epochNow();
  await adminDb.collection(WORKFLOW_COLLECTION).doc(workflowId).update({ ...patch, updatedAt: now });
  return { ...existing, ...patch, updatedAt: now };
}

export async function deleteWorkflow(userId: string, workflowId: string): Promise<boolean> {
  const existing = await getWorkflow(userId, workflowId);
  if (!existing) return false;
  await adminDb.collection(WORKFLOW_COLLECTION).doc(workflowId).delete();
  return true;
}

export async function listRuns(userId: string, workflowId?: string, limit = 40): Promise<WorkflowRun[]> {
  let query = adminDb.collection(RUNS_COLLECTION).where("userId", "==", userId) as import("firebase-admin/firestore").Query;
  if (workflowId) query = query.where("workflowId", "==", workflowId);
  query = query.orderBy("startedAt", "desc").limit(Math.min(limit, 100));
  const snap = await query.get();
  return snap.docs.map((doc) => doc.data() as WorkflowRun);
}

export async function listNotifications(userId: string, limit = 30): Promise<Array<{ id: string; title: string; body: string; createdAt: number; workflowName?: string }>> {
  const snap = await adminDb
    .collection(NOTIFICATIONS_COLLECTION)
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .limit(Math.min(limit, 100))
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as { title: string; body: string; createdAt: number; workflowName?: string }) }));
}

/* ------------------------------------------------------------------ */
/* Exécution                                                          */
/* ------------------------------------------------------------------ */

interface StepOutcome {
  output: string;
}

async function executeStep(
  userId: string,
  workflow: BusinessWorkflow,
  step: z.infer<typeof WorkflowStepSchema>,
  context: Record<string, unknown>,
): Promise<StepOutcome> {
  const config = interpolateConfig(step.config, context);
  switch (step.type) {
    case "ai_text": {
      const cfg = z
        .object({
          system: z.string().max(4_000).optional(),
          prompt: z.string().min(2).max(12_000),
          maxTokens: z.number().int().min(50).max(4_000).optional(),
        })
        .parse(config);
      const result = await runAI({
        userId,
        feature: "automations-hub",
        system: cfg.system ?? "Tu es l'assistant d'automatisation GEN3IA. Réponds en français, de façon concise et utile.",
        prompt: cfg.prompt,
        maxTokens: cfg.maxTokens ?? 900,
        task: "automation",
        temperature: 0.5,
      });
      return { output: result.text };
    }
    case "create_event": {
      const cfg = z
        .object({
          type: z.enum(["appointment", "deadline", "leave", "maintenance", "reminder"]).default("reminder"),
          title: z.string().min(1).max(200),
          description: z.string().max(2_000).optional(),
          startAt: z.string().min(4).max(40),
          endAt: z.string().max(40).optional(),
          allDay: z.boolean().optional(),
        })
        .parse(config);
      // startAt peut être une expression ISO interpolée, ou "+Nd" (dans N jours).
      const startAt = resolveFlexibleDate(cfg.startAt);
      const endAt = cfg.endAt ? resolveFlexibleDate(cfg.endAt) : undefined;
      const event = await createEvent({
        userId,
        type: cfg.type,
        title: cfg.title,
        ...(cfg.description ? { description: cfg.description } : {}),
        startAt,
        ...(endAt ? { endAt } : {}),
        ...(cfg.allDay !== undefined ? { allDay: cfg.allDay } : {}),
        related: { module: "automations", refId: workflow.id },
      });
      return { output: `Événement créé : ${event.title} (${event.startAt})` };
    }
    case "create_record": {
      const cfg = z
        .object({
          collection: z.string().regex(/^[a-z][a-zA-Z0-9_]{2,48}$/, "Collection interdite."),
          data: z.record(z.string(), z.unknown()),
        })
        .parse(config);
      const record = await createRecord({ userId, collection: cfg.collection, data: cfg.data });
      return { output: `Enregistrement ${record.id} créé dans ${cfg.collection}.` };
    }
    case "update_record": {
      const cfg = z
        .object({
          collection: z.string().regex(/^[a-z][a-zA-Z0-9_]{2,48}$/, "Collection interdite."),
          recordId: z.string().min(1).max(160),
          data: z.record(z.string(), z.unknown()),
        })
        .parse(config);
      await updateRecord(cfg.collection, userId, cfg.recordId, cfg.data);
      return { output: `Enregistrement ${cfg.recordId} mis à jour.` };
    }
    case "notification": {
      const cfg = z
        .object({
          title: z.string().min(1).max(200),
          body: z.string().max(4_000).default(""),
        })
        .parse(config);
      const now = epochNow();
      await adminDb.collection(NOTIFICATIONS_COLLECTION).add({
        userId,
        title: cfg.title,
        body: cfg.body,
        workflowId: workflow.id,
        workflowName: workflow.name,
        createdAt: now,
      });
      return { output: `Notification envoyée : ${cfg.title}` };
    }
    default:
      throw new Error(`Type d'étape inconnu : ${String((step as { type: string }).type)}`);
  }
}

/** Dates flexibles : ISO complet, YYYY-MM-DD, ou "+N d/j" (dans N jours). */
export function resolveFlexibleDate(value: string): string {
  const relative = /^\+(\d+)\s*(d|j|days?)$/i.exec(value.trim());
  if (relative) {
    const days = Number(relative[1]);
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Date invalide : ${value}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return `${value.trim()}T09:00:00.000Z`;
  return date.toISOString();
}

/**
 * Exécute un workflow : conditions → étapes séquentielles → run journalisé.
 * Ne lève que si le workflow est introuvable/désactivé ; les erreurs d'étapes
 * sont capturées dans le run (statut failed/partial).
 */
export async function runWorkflow(options: {
  userId: string;
  workflowId: string;
  trigger: "manual" | "event" | string;
  payload?: Record<string, unknown>;
}): Promise<WorkflowRun> {
  const workflow = await getWorkflow(options.userId, options.workflowId);
  if (!workflow) throw new Error("Automatisation introuvable.");
  if (!workflow.enabled) throw new Error("Automatisation désactivée : activez-la avant de l'exécuter.");

  const payload = options.payload ?? {};
  const results: Record<string, string> = {};
  const runSteps: WorkflowRunStep[] = [];
  const startedAt = epochNow();

  const context: Record<string, unknown> = { payload, workflow: { id: workflow.id, name: workflow.name }, results };
  const conditionsOk = evaluateConditions(workflow.conditions, context);

  const runRef = adminDb.collection(RUNS_COLLECTION).doc();

  if (!conditionsOk) {
    const run: WorkflowRun = {
      id: runRef.id,
      userId: options.userId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      trigger: options.trigger,
      status: "skipped",
      steps: [],
      startedAt,
      finishedAt: epochNow(),
      error: "Conditions non remplies.",
    };
    await runRef.set(run);
    return run;
  }

  let failures = 0;
  for (const step of workflow.steps) {
    try {
      const outcome = await executeStep(options.userId, workflow, step, context);
      results[step.id] = outcome.output;
      runSteps.push({ stepId: step.id, name: step.name, type: step.type, status: "success", output: outcome.output });
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      runSteps.push({ stepId: step.id, name: step.name, type: step.type, status: "failed", error: message });
      // Les étapes suivantes peuvent dépendre des sorties : on continue quand
      // même (le run reflète précisément ce qui a échoué).
    }
  }

  const run: WorkflowRun = {
    id: runRef.id,
    userId: options.userId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    trigger: options.trigger,
    status: failures === 0 ? "success" : failures === workflow.steps.length ? "failed" : "partial",
    steps: runSteps,
    startedAt,
    finishedAt: epochNow(),
  };
  await runRef.set(run);
  await adminDb
    .collection(WORKFLOW_COLLECTION)
    .doc(workflow.id)
    .update({ lastRunAt: epochNow(), runCount: (workflow.runCount ?? 0) + 1 });
  return run;
}

/**
 * Dispatch d'un événement métier vers tous les workflows actifs de
 * l'utilisateur qui écoutent ce type d'événement. Exécution séquentielle
 * avec plafond (10 workflows max par événement).
 */
export async function dispatchEvent(input: BusinessEventInput): Promise<{ dispatched: number }> {
  const snap = await adminDb
    .collection(WORKFLOW_COLLECTION)
    .where("userId", "==", input.userId)
    .where("enabled", "==", true)
    .limit(50)
    .get();

  const candidates = snap.docs
    .map((doc) => doc.data() as BusinessWorkflow)
    .filter((wf) => wf.trigger.type === "event" && wf.trigger.eventType === (input.eventType as BusinessEventType))
    .slice(0, 10);

  let dispatched = 0;
  for (const workflow of candidates) {
    try {
      await runWorkflow({ userId: input.userId, workflowId: workflow.id, trigger: "event", payload: input.payload });
      dispatched += 1;
    } catch {
      // Un workflow en erreur n'arrête pas les autres.
    }
  }
  return { dispatched };
}

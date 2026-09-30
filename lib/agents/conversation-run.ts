import "server-only";

import type { RuntimePlan, RuntimeStep } from "@/lib/agents/runtime/types";
import type { RunPhase, RunStatus, RunStep, RunStepStatus } from "@/lib/domain/conversations/types";
import { createRun, makeStep, updateRunByExecution } from "@/lib/domain/runs/repository";

/**
 * Liaison mission runtime ↔ conversation (historique mémorisé).
 *
 * Le chemin agent de /api/agent/chat exécute des plans RuntimePlan : sans
 * ce pont, seule la réponse textuelle finale était persistée et la
 * réouverture du fil perdait le plan, les étapes et les livrables. Ici le
 * plan est projeté en timeline lisible (RunStep) ET le payload runtime est
 * condensé puis enregistré sur le run : l'UI ré-affiche la mission à
 * l'ouverture exactement comme pendant son exécution.
 */

/** Correspondance statut runtime → statut de step de timeline. */
function stepStatusFrom(runtimeStatus: RuntimeStep["status"]): RunStepStatus {
  switch (runtimeStatus) {
    case "completed": return "done";
    case "failed": return "failed";
    case "running": return "in_progress";
    case "waiting_approval": return "awaiting";
    case "cancelled": return "skipped";
    case "skipped": return "skipped";
    default: return "pending";
  }
}

/** Correspondance statut d'exécution → statut de run. */
export function runStatusFromRuntime(status: string | undefined): RunStatus {
  switch (status) {
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "waiting_approval": return "awaiting_approval";
    default: return "running";
  }
}

const OUTPUT_PREVIEW_LIMIT = 4_000;

/** Aperçu texte condensé d'une sortie d'étape (jamais d'invention : extrait brut). */
function outputPreview(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return undefined;
    return text.length > OUTPUT_PREVIEW_LIMIT ? `${text.slice(0, OUTPUT_PREVIEW_LIMIT)}…` : text;
  }
  try {
    const json = JSON.stringify(value);
    return json.length > OUTPUT_PREVIEW_LIMIT ? `${json.slice(0, OUTPUT_PREVIEW_LIMIT)}…` : json;
  } catch {
    return undefined;
  }
}

const RUNTIME_LIMITS = {
  /** Plafond par valeur du payload runtime (caractères). */
  value: 24_000,
  /** Plafond global du payload sérialisé (caractères) — doc Firestore < 1 Mo. */
  total: 220_000,
};

/**
 * Condense un payload runtime (plan / sorties / observations / coût) pour
 * stockage fidèle mais borné. Aucune invention : troncature explicite.
 */
export function compactRuntimePayload(payload: {
  status?: string;
  executionId: string;
  objective?: string;
  plan: RuntimePlan;
  observations?: unknown[];
  outputs?: Record<string, unknown>;
  billing?: unknown;
  finalText?: string;
  error?: string;
}): Record<string, unknown> {
  const clip = (value: unknown, depth = 0): unknown => {
    if (typeof value === "string") {
      return value.length > RUNTIME_LIMITS.value ? `${value.slice(0, RUNTIME_LIMITS.value)}…` : value;
    }
    if (Array.isArray(value)) return value.slice(0, 60).map((item) => clip(item, depth + 1));
    if (value && typeof value === "object") {
      if (depth > 4) return "[profondeur limitée]";
      const entries = Object.entries(value as Record<string, unknown>).slice(0, 80);
      return Object.fromEntries(entries.map(([key, item]) => [key, clip(item, depth + 1)]));
    }
    return value;
  };
  const full: Record<string, unknown> = {
    status: payload.status,
    executionId: payload.executionId,
    objective: payload.objective,
    plan: clip(payload.plan),
    observations: clip((payload.observations ?? []).slice(0, 60)),
    outputs: clip(payload.outputs ?? {}),
    billing: clip(payload.billing ?? null),
    ...(payload.finalText ? { finalText: payload.finalText.slice(0, RUNTIME_LIMITS.value) } : {}),
    ...(payload.error ? { error: payload.error.slice(0, 2_000) } : {}),
  };
  // Plafond global : au-delà, on allège d'abord observations, puis sorties.
  let serialized = JSON.stringify(full);
  if (serialized.length > RUNTIME_LIMITS.total) {
    full.observations = [];
    serialized = JSON.stringify(full);
  }
  if (serialized.length > RUNTIME_LIMITS.total) {
    full.outputs = {};
    serialized = JSON.stringify(full);
  }
  if (serialized.length > RUNTIME_LIMITS.total) {
    full.plan = { executionId: payload.plan.executionId, objective: payload.plan.objective, steps: [] };
  }
  return full;
}

/**
 * Projette un plan runtime en timeline lisible : compréhension → plan →
 * exécution/outils → résultat. Les sorties déjà disponibles sont condensées
 * sur chaque étape (aperçu affichable sans rechargement).
 */
export function mapPlanStepsToRunSteps(plan: RuntimePlan, options: { outputs?: Record<string, unknown> } = {}): RunStep[] {
  const steps: RunStep[] = [
    makeStep({
      phase: "understanding",
      title: "Demande comprise",
      detail: plan.objective.slice(0, 4000),
      status: "done",
    }),
    makeStep({
      phase: "plan",
      title: "Plan proposé",
      detail: plan.steps.map((s, index) => `${index + 1}. ${s.description || s.name}`).join("\n").slice(0, 4000) || "Exécution directe.",
      status: "done",
    }),
  ];
  for (const planned of plan.steps) {
    const phase: RunPhase = planned.type === "tool" || planned.toolName ? "tools" : "execution";
    const output = options.outputs ? outputPreview(options.outputs[planned.id]) : undefined;
    steps.push(makeStep({
      phase,
      title: planned.description || planned.name,
      detail: planned.description,
      toolName: planned.toolName ?? (planned.type === "code" ? "code.execute" : undefined),
      status: stepStatusFrom(planned.status),
      ...(output ? { output } : {}),
    }));
  }
  return steps;
}

export interface AgentRunParams {
  userId: string;
  conversationId: string;
  projectId?: string;
  plan: RuntimePlan;
  /** Statut d'exécution (runtime : completed/failed/waiting_approval…). */
  status: string;
  outputs?: Record<string, unknown>;
  observations?: unknown[];
  billing?: unknown;
  finalText?: string;
  error?: string;
}

/**
 * Enregistre (création) le run d'une mission agent sur sa conversation et
 * retourne son identifiant — utilisé comme runId du message final.
 */
export async function recordAgentRun(params: AgentRunParams): Promise<string> {
  const run = await createRun({
    userId: params.userId,
    conversationId: params.conversationId,
    ...(params.projectId ? { projectId: params.projectId } : {}),
    executionId: params.plan.executionId,
    objective: params.plan.objective || params.finalText?.slice(0, 500) || "Mission agent",
    steps: mapPlanStepsToRunSteps(params.plan, { outputs: params.outputs }),
    runtime: compactRuntimePayload({
      status: params.status,
      executionId: params.plan.executionId,
      objective: params.plan.objective,
      plan: params.plan,
      observations: params.observations,
      outputs: params.outputs,
      billing: params.billing,
      finalText: params.finalText,
      error: params.error,
    }),
  });
  return run.id;
}

/**
 * Réconcilie le run d'une exécution déjà enregistrée (reprise après
 * approbation) : statut final, timeline et payload runtime mis à jour.
 * Si le run n'existe pas (checkpoint créé avant la fonctionnalité), il est
 * créé — l'historique reste complet dans tous les cas.
 */
export async function reconcileAgentRun(params: AgentRunParams): Promise<void> {
  const updated = await updateRunByExecution(params.userId, params.plan.executionId, {
    status: runStatusFromRuntime(params.status),
    steps: mapPlanStepsToRunSteps(params.plan, { outputs: params.outputs }),
    runtime: compactRuntimePayload({
      status: params.status,
      executionId: params.plan.executionId,
      objective: params.plan.objective,
      plan: params.plan,
      observations: params.observations,
      outputs: params.outputs,
      billing: params.billing,
      finalText: params.finalText,
      error: params.error,
    }),
  });
  if (!updated) {
    await recordAgentRun(params);
  }
}

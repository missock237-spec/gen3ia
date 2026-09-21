import "server-only";

import { adminDb } from "@/lib/firebase/admin";

/**
 * Observabilité des agents : agrégations sur la collection `executions`
 * (états d'exécution du runtime) — traces récentes, coûts, tokens, taux
 * d'échec, usage des outils et alertes. Conçu pour le tableau de bord
 * /observability : une seule requête Firestore (index simple userId),
 * agrégation en mémoire.
 */

export interface ExecutionSummary {
  id: string;
  objective: string;
  status: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  chargeMinor: number;
  currency: string;
  providerCostEur: number;
  inputTokens: number;
  outputTokens: number;
  stepCount: number;
  failedSteps: number;
  toolCounts: Record<string, number>;
  error?: string;
}

export interface ObservabilityAlert {
  level: "warning" | "critical";
  message: string;
  createdAt: string;
}

export interface ObservabilityOverview {
  windowDays: number;
  totals: {
    executions: number;
    completed: number;
    failed: number;
    running: number;
    waitingApproval: number;
    successRate: number;
    chargeMinor: number;
    currency: string;
    providerCostEur: number;
    inputTokens: number;
    outputTokens: number;
    avgDurationMs: number;
  };
  daily: Array<{ date: string; count: number; failed: number }>;
  tools: Array<{ name: string; count: number; failed: number }>;
  alerts: ObservabilityAlert[];
  executions: ExecutionSummary[];
}

const STATUS_LABELS: Record<string, string> = {
  pending: "en attente",
  running: "en cours",
  completed: "terminée",
  failed: "échouée",
  cancelled: "annulée",
};

function isoDate(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return "";
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function summarizeExecution(id: string, data: Record<string, unknown>): ExecutionSummary {
  const plan = (data.plan ?? {}) as { steps?: Array<{ type?: unknown; toolName?: unknown; status?: unknown }> };
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const toolCounts: Record<string, number> = {};
  for (const step of steps) {
    if (typeof step?.toolName === "string" && step.toolName) {
      toolCounts[step.toolName] = (toolCounts[step.toolName] ?? 0) + 1;
    }
  }
  const failedSteps = steps.filter((step) => step?.status === "failed").length;
  const billing = (data.billing ?? {}) as Record<string, unknown>;
  const startedAt = isoDate(data.startedAt) || isoDate(data.createdAt);
  const completedAt = isoDate(data.completedAt);
  const durationMs = startedAt && completedAt
    ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
    : undefined;

  return {
    id,
    objective: String(data.objective ?? "Mission sans objectif explicite").slice(0, 300),
    status: String(data.status ?? "pending"),
    createdAt: isoDate(data.createdAt) || startedAt,
    startedAt: startedAt || undefined,
    completedAt: completedAt || undefined,
    durationMs,
    chargeMinor: toNumber(billing.totalChargeMinor),
    currency: typeof billing.currency === "string" ? billing.currency : "XAF",
    providerCostEur: toNumber(billing.totalProviderCostEur),
    inputTokens: toNumber(billing.llmInputTokens),
    outputTokens: toNumber(billing.llmOutputTokens),
    stepCount: steps.length,
    failedSteps,
    toolCounts,
    error: typeof data.error === "string" ? data.error.slice(0, 400) : undefined,
  };
}

export async function buildObservabilityOverview(userId: string, options?: { days?: number; limit?: number }): Promise<ObservabilityOverview> {
  const windowDays = Math.min(30, Math.max(7, options?.days ?? 14));
  const limit = Math.min(200, Math.max(20, options?.limit ?? 120));

  // Requête à index simple (userId) puis tri en mémoire : aucun index
  // composite à construire côté production.
  const snap = await adminDb
    .collection("executions")
    .where("userId", "==", userId)
    .limit(limit)
    .get();

  const executions = snap.docs
    .map((doc) => summarizeExecution(doc.id, doc.data() as Record<string, unknown>))
    .filter((execution) => {
      const created = execution.createdAt ? new Date(execution.createdAt).getTime() : 0;
      return created > Date.now() - windowDays * 86_400_000;
    })
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  const totals = {
    executions: executions.length,
    completed: 0,
    failed: 0,
    running: 0,
    waitingApproval: 0,
    successRate: 0,
    chargeMinor: 0,
    currency: "XAF",
    providerCostEur: 0,
    inputTokens: 0,
    outputTokens: 0,
    avgDurationMs: 0,
  };
  const dailyMap = new Map<string, { date: string; count: number; failed: number }>();
  const toolMap = new Map<string, { name: string; count: number; failed: number }>();
  const durations: number[] = [];

  for (const execution of executions) {
    if (execution.status === "completed") totals.completed += 1;
    else if (execution.status === "failed") totals.failed += 1;
    else if (execution.status === "running" || execution.status === "pending") totals.running += 1;
    else totals.waitingApproval += 1;

    totals.chargeMinor += execution.chargeMinor;
    totals.providerCostEur += execution.providerCostEur;
    totals.inputTokens += execution.inputTokens;
    totals.outputTokens += execution.outputTokens;
    if (execution.durationMs !== undefined) durations.push(execution.durationMs);

    const day = execution.createdAt ? execution.createdAt.slice(0, 10) : "inconnu";
    const bucket = dailyMap.get(day) ?? { date: day, count: 0, failed: 0 };
    bucket.count += 1;
    if (execution.status === "failed") bucket.failed += 1;
    dailyMap.set(day, bucket);

    for (const [name, count] of Object.entries(execution.toolCounts)) {
      const tool = toolMap.get(name) ?? { name, count: 0, failed: 0 };
      tool.count += count;
      toolMap.set(name, tool);
    }
  }

  const finished = totals.completed + totals.failed;
  totals.successRate = finished > 0 ? Math.round((totals.completed / finished) * 100) : 0;
  totals.avgDurationMs = durations.length > 0
    ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
    : 0;

  // Alertes simples : échecs répétés sur 24 h et dépense inhabituelle.
  const dayAgo = Date.now() - 86_400_000;
  const recent = executions.filter((execution) => execution.createdAt && new Date(execution.createdAt).getTime() > dayAgo);
  const recentFailures = recent.filter((execution) => execution.status === "failed");
  const alerts: ObservabilityAlert[] = [];
  if (recentFailures.length >= 3) {
    alerts.push({
      level: "critical",
      message: `${recentFailures.length} exécutions ont échoué en 24 h — inspectez les traces récentes et le journal des décisions.`,
      createdAt: new Date().toISOString(),
    });
  } else if (recentFailures.length > 0) {
    alerts.push({
      level: "warning",
      message: `${recentFailures.length} échec(s) en 24 h : ${recentFailures[0].error ?? recentFailures[0].objective.slice(0, 120)}`,
      createdAt: new Date().toISOString(),
    });
  }
  const dailyCharge = recent.reduce((sum, execution) => sum + execution.chargeMinor, 0);
  if (dailyCharge > 50_000) {
    alerts.push({
      level: "warning",
      message: `Dépense des dernières 24 h : ${(dailyCharge / 100).toFixed(2)} XAF — au-delà du seuil de vigilance (500 XAF).`,
      createdAt: new Date().toISOString(),
    });
  }

  const daily = [...dailyMap.values()]
    .filter((bucket) => bucket.date !== "inconnu")
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-windowDays);

  const tools = [...toolMap.values()].sort((a, b) => b.count - a.count).slice(0, 12);

  return {
    windowDays,
    totals,
    daily,
    tools,
    alerts,
    executions: executions.slice(0, 60),
  };
}

export { STATUS_LABELS };

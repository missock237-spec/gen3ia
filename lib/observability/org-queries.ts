import "server-only";

import { adminDb } from "@/lib/firebase/admin";

import { summarizeExecution, type ExecutionSummary } from "./queries";

/**
 * Métriques d'usage agrégées PAR ORGANISATION (saas-roadmap §3, Task 43).
 *
 * Complète buildObservabilityOverview (vue utilisateur) avec une vue
 * entreprise : toutes les exécutions des membres de l'organisation, dans la
 * fenêtre, agrégées par agent, outil et jour — la dimension manquante pour
 * piloter une org (quotas, budgets, adoptions des agents).
 *
 * Accès : la route appelante DOIT valider l'appartenance via
 * requireOrgContext (lib/tenants/organizations) avant d'appeler ce module.
 *
 * I/O Firestore maîtrisée :
 *   - membres : sous-collection organizations/{orgId}/members (lecture
 *     directe par uids, sans index composite) ;
 *   - exécutions : requêtes `where userId in (≤30 uids)` paginées par lots
 *     (limite Firestore `in`), fenêtre + plafond de documents côté code.
 */

export interface OrgAgentUsage {
  agentId: string;
  executions: number;
  failed: number;
  chargeMinor: number;
  inputTokens: number;
  outputTokens: number;
  providerCostEur: number;
}

export interface OrgUsageOverview {
  orgId: string;
  windowDays: number;
  membersCovered: number;
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
  byAgent: OrgAgentUsage[];
  byTool: Array<{ name: string; count: number; failed: number }>;
  byDay: Array<{ date: string; count: number; failed: number }>;
}

/** Nombre maximal de valeurs par requête Firestore `in` (limite plateforme). */
const IN_CHUNK = 30;

/** Liste paginée des uids membres d'une organisation. */
async function listOrgMemberUids(orgId: string, max = 500): Promise<string[]> {
  const snap = await adminDb
    .collection("organizations")
    .doc(orgId)
    .collection("members")
    .limit(max)
    .get();
  return snap.docs.map((doc) => doc.id);
}

/** Lit les exécutions récentes d'un lot d'utilisateurs (≤ IN_CHUNK uids). */
async function fetchExecutionSummariesForChunk(
  uids: string[],
  limit: number,
): Promise<ExecutionSummary[]> {
  const snap = await adminDb
    .collection("executions")
    .where("userId", "in", uids)
    .limit(limit)
    .get();
  return snap.docs.map((doc) => summarizeExecution(doc.id, doc.data() as Record<string, unknown>));
}

/**
 * Agrégation PURE (testée) des résumés d'exécution en vue organisation :
 * totaux, dimensions agent / outil / jour. Aucune dépendance Firestore.
 */
export function aggregateOrgUsage(
  orgId: string,
  summaries: ExecutionSummary[],
  membersCovered: number,
  windowDays: number,
): OrgUsageOverview {
  const totals = {
    executions: summaries.length,
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

  const agentMap = new Map<string, OrgAgentUsage>();
  const toolMap = new Map<string, { name: string; count: number; failed: number }>();
  const dayMap = new Map<string, { date: string; count: number; failed: number }>();
  const durations: number[] = [];

  for (const execution of summaries) {
    if (execution.status === "completed") totals.completed += 1;
    else if (execution.status === "failed") totals.failed += 1;
    else if (execution.status === "running" || execution.status === "pending") totals.running += 1;
    else totals.waitingApproval += 1;

    totals.chargeMinor += execution.chargeMinor;
    totals.providerCostEur += execution.providerCostEur;
    totals.inputTokens += execution.inputTokens;
    totals.outputTokens += execution.outputTokens;
    if (execution.durationMs !== undefined) durations.push(execution.durationMs);

    // Dimension agent (quotas, budgets, adoption) — exécutions rattachées
    // à un agent explicitement ; les missions ad-hoc restent hors dimension.
    if (execution.agentId) {
      const agent = agentMap.get(execution.agentId) ?? {
        agentId: execution.agentId,
        executions: 0,
        failed: 0,
        chargeMinor: 0,
        inputTokens: 0,
        outputTokens: 0,
        providerCostEur: 0,
      };
      agent.executions += 1;
      if (execution.status === "failed") agent.failed += 1;
      agent.chargeMinor += execution.chargeMinor;
      agent.inputTokens += execution.inputTokens;
      agent.outputTokens += execution.outputTokens;
      agent.providerCostEur += execution.providerCostEur;
      agentMap.set(execution.agentId, agent);
    }

    const day = execution.createdAt ? execution.createdAt.slice(0, 10) : "inconnu";
    const dayBucket = dayMap.get(day) ?? { date: day, count: 0, failed: 0 };
    dayBucket.count += 1;
    if (execution.status === "failed") dayBucket.failed += 1;
    dayMap.set(day, dayBucket);

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

  return {
    orgId,
    windowDays,
    membersCovered,
    totals,
    byAgent: [...agentMap.values()]
      .sort((a, b) => b.executions - a.executions)
      .map(({ agentId, executions, failed, chargeMinor, inputTokens, outputTokens, providerCostEur }) => ({
        agentId,
        executions,
        failed,
        chargeMinor,
        inputTokens,
        outputTokens,
        providerCostEur,
      })),
    byTool: [...toolMap.values()].sort((a, b) => b.count - a.count).slice(0, 12),
    byDay: [...dayMap.values()]
      .filter((bucket) => bucket.date !== "inconnu")
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-windowDays),
  };
}

/** Vue d'usage complète d'une organisation (I/O + agrégation). */
export async function buildOrgUsageOverview(
  orgId: string,
  options?: { days?: number; limit?: number },
): Promise<OrgUsageOverview> {
  const windowDays = Math.min(30, Math.max(7, options?.days ?? 14));
  const limit = Math.min(500, Math.max(50, options?.limit ?? 200));

  const uids = await listOrgMemberUids(orgId);
  if (uids.length === 0) {
    return aggregateOrgUsage(orgId, [], 0, windowDays);
  }

  const chunks: string[][] = [];
  for (let i = 0; i < uids.length; i += IN_CHUNK) chunks.push(uids.slice(i, i + IN_CHUNK));

  const perChunkLimit = Math.max(20, Math.ceil(limit / chunks.length));
  const batches = await Promise.all(chunks.map((chunk) => fetchExecutionSummariesForChunk(chunk, perChunkLimit)));

  const windowStart = Date.now() - windowDays * 86_400_000;
  const summaries = batches
    .flat()
    .filter((execution) => {
      const created = execution.createdAt ? new Date(execution.createdAt).getTime() : 0;
      return created > windowStart;
    })
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  return aggregateOrgUsage(orgId, summaries, uids.length, windowDays);
}

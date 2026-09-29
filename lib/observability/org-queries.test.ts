import { describe, expect, it } from "vitest";

/**
 * Tests de l'agrégation PURE de la vue d'usage organisation (Task 43).
 *
 * La partie I/O Firestore (listOrgMemberUids, requêtes `in`) est volontairement
 * hors périmètre : seule la logique d'agrégation est testée — déterministe,
 * sans réseau.
 */

import { aggregateOrgUsage } from "./org-queries";
import type { ExecutionSummary } from "./queries";

function summary(overrides: Partial<ExecutionSummary> & { id: string }): ExecutionSummary {
  return {
    objective: "objectif test",
    status: "completed",
    createdAt: "2026-09-20T10:00:00.000Z",
    chargeMinor: 0,
    currency: "XAF",
    providerCostEur: 0,
    inputTokens: 0,
    outputTokens: 0,
    stepCount: 2,
    failedSteps: 0,
    toolCounts: {},
    ...overrides,
  };
}

describe("aggregateOrgUsage (vue organisation)", () => {
  it("org vide : totaux nuls, tableaux vides, taux de succès 0", () => {
    const view = aggregateOrgUsage("org-1", [], 0, 14);
    expect(view.orgId).toBe("org-1");
    expect(view.membersCovered).toBe(0);
    expect(view.totals).toMatchObject({ executions: 0, successRate: 0, chargeMinor: 0 });
    expect(view.byAgent).toEqual([]);
    expect(view.byTool).toEqual([]);
    expect(view.byDay).toEqual([]);
  });

  it("totaux : statuts, coûts, tokens, taux de succès arrondi", () => {
    const summaries = [
      summary({ id: "1", status: "completed", chargeMinor: 150, inputTokens: 100, outputTokens: 200 }),
      summary({ id: "2", status: "completed", chargeMinor: 250, inputTokens: 50, outputTokens: 100 }),
      summary({ id: "3", status: "failed", chargeMinor: 50 }),
      summary({ id: "4", status: "running" }),
      summary({ id: "5", status: "waiting_approval" }),
    ];
    const view = aggregateOrgUsage("org-1", summaries, 3, 14);
    expect(view.totals).toMatchObject({
      executions: 5,
      completed: 2,
      failed: 1,
      running: 1,
      waitingApproval: 1,
      successRate: 67, // 2/3 → 66,67 → 67
      chargeMinor: 450,
      inputTokens: 150,
      outputTokens: 300,
    });
    expect(view.membersCovered).toBe(3);
  });

  it("dimension agent : agrégation par agentId, tri par exécutions desc, hors missions ad-hoc", () => {
    const summaries = [
      summary({ id: "1", agentId: "agent-a", chargeMinor: 100, inputTokens: 10, outputTokens: 10, providerCostEur: 0.01 }),
      summary({ id: "2", agentId: "agent-a", status: "failed", chargeMinor: 40, providerCostEur: 0.01 }),
      summary({ id: "3", agentId: "agent-b", chargeMinor: 500, outputTokens: 80 }),
      summary({ id: "4", status: "completed" }), // mission ad-hoc : pas d'agent
    ];
    const view = aggregateOrgUsage("org-1", summaries, 2, 14);
    expect(view.byAgent).toHaveLength(2);
    expect(view.byAgent[0]).toEqual({
      agentId: "agent-a",
      executions: 2,
      failed: 1,
      chargeMinor: 140,
      inputTokens: 10,
      outputTokens: 10,
      providerCostEur: 0.02,
    });
    expect(view.byAgent[1].agentId).toBe("agent-b");
    expect(view.byAgent[1].executions).toBe(1);
  });

  it("dimensions jour et outil : bucket par date ISO, exclusion des dates inconnues", () => {
    const summaries = [
      summary({ id: "1", createdAt: "2026-09-20T10:00:00.000Z", toolCounts: { web_search: 2 } }),
      summary({ id: "2", createdAt: "2026-09-20T15:00:00.000Z", status: "failed", toolCounts: { web_search: 1, mailer: 1 } }),
      summary({ id: "3", createdAt: "", toolCounts: { mailer: 1 } }), // date inconnue
    ];
    const view = aggregateOrgUsage("org-1", summaries, 1, 14);
    expect(view.byDay).toHaveLength(1);
    expect(view.byDay[0]).toEqual({ date: "2026-09-20", count: 2, failed: 1 });
    expect(view.byTool[0]).toEqual({ name: "web_search", count: 3, failed: 0 });
    expect(view.byTool[1]).toEqual({ name: "mailer", count: 2, failed: 0 });
  });

  it("moyenne de durée : moyenne arithmétique arrondie des exécutions terminées", () => {
    const summaries = [
      summary({ id: "1", durationMs: 1000, completedAt: "2026-09-20T10:00:01.000Z" }),
      summary({ id: "2", durationMs: 2000, completedAt: "2026-09-20T10:00:02.000Z" }),
    ];
    const view = aggregateOrgUsage("org-1", summaries, 1, 14);
    expect(view.totals.avgDurationMs).toBe(1500);
  });
});

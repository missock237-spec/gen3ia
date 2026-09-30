import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Étape 1 du plan 20 — pont mission runtime ↔ historique conversation :
 * projection du plan en timeline lisible, condensation bornée du payload
 * runtime (jamais d'invention), mapping des statuts.
 */

vi.mock("@/lib/domain/runs/repository", () => ({
  createRun: vi.fn(),
  makeStep: vi.fn((input: { phase: string; title: string; detail?: string; toolName?: string; status?: string; output?: string }) => ({
    id: `step-${Math.random().toString(36).slice(2, 8)}`,
    ...input,
    status: input.status ?? "pending",
  })),
  updateRunByExecution: vi.fn(),
}));

import { compactRuntimePayload, mapPlanStepsToRunSteps, runStatusFromRuntime } from "./conversation-run";

const PLAN = {
  executionId: "exec-1",
  objective: "Rédiger un rapport mensuel",
  steps: [
    { id: "s1", type: "llm" as const, name: "Rédiger", description: "Rédiger le rapport", dependencies: [], status: "completed" as const, input: {}, skillIds: [], maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false },
    { id: "s2", type: "tool" as const, name: "Chercher", description: "Chercher les données", toolName: "web.search", dependencies: [], status: "failed" as const, input: {}, skillIds: [], maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false },
    { id: "s3", type: "tool" as const, name: "Attendre", description: "Action sensible", toolName: "file.delete", dependencies: [], status: "waiting_approval" as const, input: {}, skillIds: [], maxRetries: 2, timeoutMs: 120_000, sideEffect: true, requiresApproval: true },
  ],
  maxConcurrency: 2,
  maxIterations: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mapPlanStepsToRunSteps — projection du plan en timeline lisible", () => {
  it("produit compréhension + plan + une étape par étape runtime", () => {
    const steps = mapPlanStepsToRunSteps(PLAN, { outputs: { s1: "Rapport complet." } });
    expect(steps).toHaveLength(2 + PLAN.steps.length);
    expect(steps[0]).toMatchObject({ phase: "understanding", status: "done" });
    expect(steps[1]).toMatchObject({ phase: "plan", status: "done" });
    expect(steps[1].detail).toContain("1. Rédiger le rapport");
    expect(steps[2]).toMatchObject({ phase: "execution", status: "done", output: "Rapport complet." });
    expect(steps[3]).toMatchObject({ phase: "tools", toolName: "web.search", status: "failed" });
    expect(steps[4]).toMatchObject({ phase: "tools", toolName: "file.delete", status: "awaiting" });
  });

  it("sans sorties fournies : les étapes restent sans aperçu (aucune invention)", () => {
    const steps = mapPlanStepsToRunSteps(PLAN);
    expect(steps[2].output).toBeUndefined();
    expect(steps[3].output).toBeUndefined();
  });
});

describe("compactRuntimePayload — condensation bornée du payload runtime", () => {
  it("tronque explicitement les valeurs trop longues (marqueur …, jamais d'invention)", () => {
    const payload = compactRuntimePayload({
      executionId: "exec-1",
      plan: PLAN,
      outputs: { s1: "x".repeat(50_000) },
    });
    const outputs = payload.outputs as Record<string, string>;
    expect(outputs.s1.length).toBeLessThanOrEqual(24_001);
    expect(outputs.s1.endsWith("…")).toBe(true);
  });

  it("allège d'abord observations puis sorties au-delà du plafond global (doc Firestore < 1 Mo)", () => {
    const bigObservations = Array.from({ length: 50 }, (_, i) => ({ stepId: `s${i}`, output: "y".repeat(20_000) }));
    const payload = compactRuntimePayload({
      executionId: "exec-1",
      plan: PLAN,
      observations: bigObservations,
      outputs: { s1: "z".repeat(300_000) },
    });
    expect(payload.observations).toEqual([]);
    expect(JSON.stringify(payload).length).toBeLessThan(400_000);
  });

  it("conserve statut, coût et texte final", () => {
    const payload = compactRuntimePayload({
      executionId: "exec-1",
      status: "completed",
      plan: PLAN,
      billing: { currency: "XAF", totalChargeMinor: 5 },
      finalText: "Livrable prêt.",
    });
    expect(payload.status).toBe("completed");
    expect(payload.billing).toMatchObject({ totalChargeMinor: 5 });
    expect(payload.finalText).toBe("Livrable prêt.");
  });
});

describe("runStatusFromRuntime — mapping des statuts d'exécution", () => {
  it("mappe les statuts runtime vers les statuts de run", () => {
    expect(runStatusFromRuntime("completed")).toBe("completed");
    expect(runStatusFromRuntime("failed")).toBe("failed");
    expect(runStatusFromRuntime("cancelled")).toBe("cancelled");
    expect(runStatusFromRuntime("waiting_approval")).toBe("awaiting_approval");
    expect(runStatusFromRuntime("running")).toBe("running");
    expect(runStatusFromRuntime(undefined)).toBe("running");
  });
});

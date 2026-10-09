import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde quota de l'exécuteur de workflows (Task 110-e).
 *
 * Les workflows déclenchés par l'utilisateur (POST /api/workflows/[id]/run,
 * maxDuration 300, et l'outil agent workflow.run) persistaient leur état de
 * run (`workflowRuns`) sur Firestore BRUT : sous quota quotidien épuisé,
 * save() pendaît SANS lever (Task 97) et retenait la requête utilisateur
 * jusqu'au kill de la fonction — le workflow fantomait.
 *
 * Contrat après fix : chaque touche (lecture de reprise, save() par vague,
 * doc d'approbation) est bornée (6 s) + disjoncteur, via le MÊME
 * runFirestoreGuarded que la file de missions. L'échec est rapide,
 * quota-classifié, capté par le catch final du run (statut honnête).
 */

const mocks = vi.hoisted(() => ({
  docGet: vi.fn(),
  docSet: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ get: mocks.docGet, set: mocks.docSet })),
    })),
  },
}));

vi.mock("@/lib/agents/repository", () => ({
  getAgentForUser: vi.fn(async () => null),
}));

vi.mock("@/lib/agents/charter", () => ({
  buildAgentCharter: vi.fn(() => "charte"),
}));

vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: vi.fn(),
}));

vi.mock("@/lib/agents/runtime/secure-tool-executor", () => ({
  executeToolSecurely: vi.fn(),
}));

const quotaError = () => Object.assign(new Error("Quota exceeded for quota group 'default'."), { code: 8 });

function openBreaker(): void {
  noteFirestoreQuotaError(quotaError());
  noteFirestoreQuotaError(quotaError());
  noteFirestoreQuotaError(quotaError());
}

beforeEach(() => {
  vi.useFakeTimers();
  resetQuotaGuardForTests();
  mocks.docGet.mockReset();
  mocks.docSet.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

import { getQuotaGuardStats, noteFirestoreQuotaError, resetQuotaGuardForTests } from "@/lib/db/quota-guard";
import { runWorkflowGraph, type WorkflowRunState } from "./executor";
import type { Workflow } from "./types";

const WORKFLOW: Workflow = {
  id: "wf-110e",
  version: 1,
  name: "Test",
  nodes: [
    { id: "n1", name: "Gabarit", type: "transform", enabled: true, config: { template: "Bonjour {{n0}}" } },
    { id: "n2", name: "Sortie", type: "output", enabled: true, config: { template: "{{n1}}" } },
  ],
  edges: [{ id: "e1", source: "n1", target: "n2" }],
} as unknown as Workflow;

async function outcomeWithinDeadline(pending: Promise<unknown>): Promise<string> {
  return Promise.race([
    pending.then(
      () => "resolved" as const,
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}` as const,
    ),
    vi.advanceTimersByTimeAsync(7_000).then(() => "timeout" as const),
  ]);
}

describe("runWorkflowGraph sous garde (110-e)", () => {
  it("chemin nominal inchangé : exécution complète + checkpoint persisté (régression)", async () => {
    mocks.docSet.mockResolvedValue(undefined);
    const state = await runWorkflowGraph({ userId: "user-1", workflow: WORKFLOW });
    expect(state.status).toBe("completed");
    expect(state.result).toBe("Bonjour "); // n1 transforme une sortie absente (n0 inexistant) en chaîne vide, n2 la propage
    expect(mocks.docSet).toHaveBeenCalledTimes(3); // save après chaque vague (2) + save final
    expect(getQuotaGuardStats().state).toBe("closed");
  });

  it("VERROU 110-e : disjoncteur ouvert → rejet immédiat quota-classifié, Firestore JAMAIS touché", async () => {
    openBreaker();
    mocks.docSet.mockResolvedValue(undefined);
    await expect(runWorkflowGraph({ userId: "user-1", workflow: WORKFLOW })).rejects.toThrow("Firestore sous quota");
    expect(mocks.docSet).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : save qui pend (quota quotidien) → échec rapide au délai + disjoncteur ouvert (requête utilisateur plus jamais retenue)", async () => {
    mocks.docSet.mockImplementation(() => new Promise<void>(() => undefined)); // stall
    const outcome = await outcomeWithinDeadline(runWorkflowGraph({ userId: "user-1", workflow: WORKFLOW }));
    expect(outcome).toMatch(/^rejected:/);
    expect(outcome).toContain("quota");
    expect(getQuotaGuardStats().state).toBe("open");
  });

  it("VERROU 110-e : reprise (runId), disjoncteur ouvert → rejet immédiat, lecture JAMAIS émise", async () => {
    openBreaker();
    mocks.docGet.mockResolvedValue({ exists: true, data: () => ({ userId: "user-1" }) as WorkflowRunState });
    await expect(runWorkflowGraph({ userId: "user-1", workflow: WORKFLOW, runId: "run-1", resumeApproved: true })).rejects.toThrow("Firestore sous quota");
    expect(mocks.docGet).not.toHaveBeenCalled();
  });
});

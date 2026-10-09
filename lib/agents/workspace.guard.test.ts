import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde quota du tableau « agent IA » (tâches workspace, Task 110-e).
 *
 * Second symptôme production (« dans l'agent ia aucune tâche ne s'exécute »)
 * : createWorkspaceTask (TRANSACTION 3 documents) et approveWorkspaceTask
 * sont des écritures BRUTES posées par l'interface — sous quota Firestore
 * épuisé elles pendaient SANS lever (Task 97), la requête était retenue
 * jusqu'au kill maxDuration 300 et la tâche n'existait JAMAIS (ni liste, ni
 * exécution possible). La liste et le détail sont en plus POLLÉS par l'UI.
 *
 * Contrat après fix : chaque touche est bornée (6 s) + disjoncteur via le
 * MÊME runFirestoreGuarded que la file de missions (aucune duplication) —
 * échec rapide quota-classifié (503 actionnable via errorStatus) au lieu
 * d'une pendule.
 */

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  queryGet: vi.fn(),
  runTransaction: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ get: mocks.get, update: mocks.update })),
      where: vi.fn(() => ({ limit: vi.fn(() => ({ get: mocks.queryGet })) })),
    })),
    runTransaction: mocks.runTransaction,
  },
}));

vi.mock("@/lib/agents/planner/service", () => ({
  createAgentPlan: vi.fn(async () => ({
    executionId: "exec-110e",
    objective: "objectif",
    steps: [],
  })),
}));

vi.mock("@/lib/agents/runtime/pause", () => ({
  requestExecutionPause: vi.fn(async () => undefined),
  requestExecutionStop: vi.fn(async () => undefined),
  clearExecutionPause: vi.fn(async () => undefined),
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
  mocks.get.mockReset();
  mocks.update.mockReset();
  mocks.queryGet.mockReset();
  mocks.runTransaction.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

import { getQuotaGuardStats, noteFirestoreQuotaError, resetQuotaGuardForTests } from "@/lib/db/quota-guard";
import { approveWorkspaceTask, createWorkspaceTask, listWorkspaceTasks } from "./workspace";

const TASK_DOC = {
  exists: true,
  get: (key: string) => (key === "ownerId" ? "user-1" : key === "status" ? "awaiting_approval" : undefined),
  data: () => ({
    ownerId: "user-1",
    objective: "objectif",
    status: "awaiting_approval",
    activeBranchId: "branch-1",
    createdAt: { toMillis: () => 1 },
    updatedAt: { toMillis: () => 1 },
  }),
};

async function outcomeWithinDeadline(pending: Promise<unknown>): Promise<string> {
  return Promise.race([
    pending.then(
      () => "resolved" as const,
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}` as const,
    ),
    vi.advanceTimersByTimeAsync(7_000).then(() => "timeout" as const),
  ]);
}

describe("tâches workspace sous garde (110-e)", () => {
  it("VERROU 110-e : disjoncteur ouvert → createWorkspaceTask rejeté immédiatement, transaction JAMAIS ouverte", async () => {
    openBreaker();
    mocks.runTransaction.mockResolvedValue(undefined);
    await expect(createWorkspaceTask("user-1", "objectif")).rejects.toThrow("Firestore sous quota");
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : disjoncteur ouvert → approveWorkspaceTask rejeté immédiatement, écriture JAMAIS émise", async () => {
    openBreaker();
    mocks.get.mockResolvedValue(TASK_DOC);
    mocks.update.mockResolvedValue(undefined);
    await expect(approveWorkspaceTask("user-1", "task-1")).rejects.toThrow("Firestore sous quota");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : transaction de création qui pend → rejet quota-classifié au délai (requête plus jamais retenue 300 s)", async () => {
    mocks.runTransaction.mockImplementation(() => new Promise<void>(() => undefined)); // stall
    const outcome = await outcomeWithinDeadline(createWorkspaceTask("user-1", "objectif"));
    expect(outcome).toMatch(/^rejected:/);
    expect(outcome).toContain("quota");
    expect(getQuotaGuardStats().state).toBe("open");
  });

  it("VERROU 110-e : liste pollée par l'UI qui pend → rejet au délai (le tableau reste lisible en incident)", async () => {
    mocks.queryGet.mockImplementation(() => new Promise(() => undefined)); // stall
    const outcome = await outcomeWithinDeadline(listWorkspaceTasks("user-1"));
    expect(outcome).toMatch(/^rejected:/);
    expect(getQuotaGuardStats().state).toBe("open");
  });

  it("chemin nominal inchangé : tâche créée puis approuvée (régression)", async () => {
    mocks.runTransaction.mockResolvedValue(undefined);
    mocks.get.mockResolvedValue(TASK_DOC);
    mocks.update.mockResolvedValue(undefined);

    const created = await createWorkspaceTask("user-1", "objectif");
    expect(created.status).toBe("awaiting_approval");
    expect(mocks.runTransaction).toHaveBeenCalledTimes(1);

    const approved = await approveWorkspaceTask("user-1", created.id);
    expect(approved.status).toBe("awaiting_approval");
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(getQuotaGuardStats().state).toBe("closed");
  });
});

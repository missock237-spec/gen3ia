import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde quota de la file de missions (Task 110-d) — PREUVE cause racine.
 *
 * Contexte production (« plus aucune tâche ne s'exécute », chat texte OK) :
 * les touches Firestore BRUTES de la file (createQueuedMission,
 * claimMissionTick, getMissionRun…) pendaient ou mouraient sous quota
 * Firestore — sans deadline ni disjoncteur — pendant que le chat (R2,
 * Task 109) répondait normalement.
 *
 * Contrat après fix : chaque touche de la file est bornée (6 s) et
 * quota-classifiée (disjoncteur Task 95-b). Les verrous « disjoncteur ouvert
 * → rejet immédiat, Firestore JAMAIS touché » échouent sur l'implémentation
 * c8eac8c (appels adminDb directs) et passent après correctif.
 */

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn(),
  runTransaction: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ set: mocks.set, get: mocks.get })),
    })),
    runTransaction: mocks.runTransaction,
  },
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
  mocks.set.mockReset();
  mocks.get.mockReset();
  mocks.runTransaction.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

import { getQuotaGuardStats, noteFirestoreQuotaError, resetQuotaGuardForTests } from "@/lib/db/quota-guard";
import {
  claimMissionTick,
  createQueuedMission,
  finalizeMissionRun,
  getMissionRun,
  persistMissionProgress,
  type MissionQueueRecord,
} from "./mission-queue";

const PLAN = {
  executionId: "exec-110d",
  objective: "Étude de marché",
  steps: [
    { id: "s1", type: "llm" as const, name: "Analyse", description: "d", dependencies: [], status: "pending" as const, input: {}, skillIds: [] as string[], maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false },
  ],
  maxConcurrency: 1,
  maxIterations: 5,
};

const INPUT = {
  runId: "a1b2c3d4-1111-2222-3333-444455556666",
  executionId: "exec-110d",
  userId: "user-1",
  objective: "Étude de marché",
  plan: PLAN,
};

const RECORD: Partial<MissionQueueRecord> = {
  runId: INPUT.runId,
  userId: "user-1",
  executionId: "exec-110d",
  objective: "Étude de marché",
  status: "queued" as const,
  attempts: 0,
  plan: PLAN,
  timeline: [],
  pendingCount: 1,
  createdAtMs: 1,
  updatedAtMs: 2,
};

/** Résultat d'un appel potentiellement PENDANT (stall) : rejet au délai du garde ou timeout du test. */
async function outcomeWithinDeadline(pending: Promise<unknown>): Promise<string> {
  return Promise.race([
    pending.then(
      () => "resolved" as const,
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}` as const,
    ),
    vi.advanceTimersByTimeAsync(7_000).then(() => "timeout" as const),
  ]);
}

describe("createQueuedMission sous garde (110-d)", () => {
  it("VERROU 110-d : disjoncteur ouvert → rejet immédiat, Firestore JAMAIS touché", async () => {
    openBreaker();
    mocks.set.mockResolvedValue(undefined);
    await expect(createQueuedMission(INPUT)).rejects.toThrow("Firestore sous quota");
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("VERROU 110-d : écriture qui pend (quota quotidien) → rejet quota-classifié au délai + disjoncteur ouvert", async () => {
    mocks.set.mockImplementation(() => new Promise<void>(() => undefined)); // stall : ne répond JAMAIS
    const outcome = await outcomeWithinDeadline(createQueuedMission(INPUT));
    expect(outcome).toMatch(/^rejected:/);
    expect(outcome).toContain("quota");
    expect(getQuotaGuardStats().state).toBe("open");
  });

  it("chemin nominal inchangé : l'écriture aboutit (régression)", async () => {
    mocks.set.mockResolvedValue(undefined);
    await expect(createQueuedMission(INPUT)).resolves.toBeUndefined();
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(getQuotaGuardStats().state).toBe("closed");
  });
});

describe("claimMissionTick sous garde (110-d)", () => {
  it("VERROU 110-d : disjoncteur ouvert → rejet immédiat, transaction JAMAIS ouverte", async () => {
    openBreaker();
    mocks.runTransaction.mockResolvedValue({ kind: "missing" } as never);
    await expect(claimMissionTick(INPUT.runId)).rejects.toThrow("Firestore sous quota");
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("chemin nominal inchangé : claim transactionnel (régression)", async () => {
    mocks.runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: vi.fn().mockResolvedValue({ exists: true, data: () => RECORD }),
        update: vi.fn(),
      }),
    );
    const claim = await claimMissionTick(INPUT.runId);
    expect(claim.kind).toBe("claimed");
    if (claim.kind === "claimed") {
      expect(claim.record.attempts).toBe(1);
      expect(claim.record.status).toBe("running");
    }
  });
});

describe("getMissionRun sous garde (110-d)", () => {
  it("VERROU 110-d : disjoncteur ouvert → rejet quota-classifié (polling 503 actionnable), lecture JAMAIS émise", async () => {
    openBreaker();
    mocks.get.mockResolvedValue({ exists: false });
    await expect(getMissionRun("user-1", INPUT.runId)).rejects.toThrow("Firestore sous quota");
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("chemin nominal inchangé : lecture propriétaire (régression)", async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => RECORD });
    const record = await getMissionRun("user-1", INPUT.runId);
    expect(record?.runId).toBe(INPUT.runId);
    // Anti-énumération conservée : un autre uid ne lit rien.
    await expect(getMissionRun("user-2", INPUT.runId)).resolves.toBeNull();
  });
});

describe("touches fail-soft sous garde (110-d)", () => {
  it("persistMissionProgress / finalizeMissionRun : sous quota elles échouent VITE (jamais de tick pendu) et restent silencieuses", async () => {
    openBreaker();
    const progress = await outcomeWithinDeadline(persistMissionProgress(INPUT.runId, [{ id: "s1", status: "pending" }]));
    expect(progress).toBe("resolved"); // fail-soft : avalé, pas propagé — mais REJETÉ SOUS-JACENT (pas de pendule)
    expect(mocks.set).not.toHaveBeenCalled();
    const finalize = await outcomeWithinDeadline(finalizeMissionRun(INPUT.runId, "completed"));
    expect(finalize).toBe("resolved");
    expect(mocks.set).not.toHaveBeenCalled();
  });
});

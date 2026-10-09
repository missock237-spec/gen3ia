import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde quota des checkpoints runtime (Task 110-d) — PREUVE cause racine.
 *
 * `createCheckpoint` est appelé par AgentRuntime.run() AVANT toute
 * exécution : en appel Firestore BRUT, sous quota quotidien épuisé
 * (écritures muettes, Task 97) il pendait jusqu'au kill de la fonction —
 * la mission ne démarre jamais, pendant que le chat (R2) répond encore.
 *
 * Contrat après fix : save/create/loadCheckpoint sont bornés (6 s) et
 * quota-classifiés. Les verrous « disjoncteur ouvert → rejet immédiat,
 * Firestore JAMAIS touché » échouent sur l'implémentation c8eac8c.
 */

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ set: mocks.set, get: mocks.get })),
    })),
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
});

afterEach(() => {
  vi.useRealTimers();
});

import { noteFirestoreQuotaError, resetQuotaGuardForTests } from "@/lib/db/quota-guard";
import { createCheckpoint, loadCheckpoint, saveCheckpoint } from "./checkpoint";

const STATE = {
  executionId: "exec-110d",
  userId: "user-1",
  objective: "Étude de marché",
  status: "running" as const,
  plan: { executionId: "exec-110d", objective: "Étude de marché", steps: [], maxConcurrency: 1, maxIterations: 5 },
  observations: [],
  evaluations: [],
  outputs: {},
  iteration: 0,
  totalRetries: 0,
  maxTotalRetries: 15,
  billing: { currency: "XAF", totalChargeMinor: 0, totalProviderCostEur: 0, llmInputTokens: 0, llmOutputTokens: 0 },
} as never;

describe("checkpoint sous garde (110-d)", () => {
  it("VERROU 110-d : createCheckpoint — disjoncteur ouvert → rejet immédiat, Firestore JAMAIS touché", async () => {
    openBreaker();
    mocks.set.mockResolvedValue(undefined);
    await expect(createCheckpoint(STATE)).rejects.toThrow("Firestore sous quota");
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("VERROU 110-d : createCheckpoint — écriture qui pend → rejet quota-classifié au délai", async () => {
    mocks.set.mockImplementation(() => new Promise<void>(() => undefined));
    const outcome = await Promise.race([
      createCheckpoint(STATE).then(
        () => "resolved" as const,
        (error: Error) => `rejected: ${error.message}` as const,
      ),
      vi.advanceTimersByTimeAsync(7_000).then(() => "timeout" as const),
    ]);
    expect(outcome).toMatch(/^rejected:/);
    expect(outcome).toContain("quota");
  });

  it("VERROU 110-d : saveCheckpoint — disjoncteur ouvert → rejet immédiat (le runner l'absorbe en fail-soft)", async () => {
    openBreaker();
    mocks.set.mockResolvedValue(undefined);
    await expect(saveCheckpoint(STATE)).rejects.toThrow("Firestore sous quota");
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("VERROU 110-d : loadCheckpoint — disjoncteur ouvert → rejet immédiat (tick → 500 redélivrance)", async () => {
    openBreaker();
    mocks.get.mockResolvedValue({ exists: false });
    await expect(loadCheckpoint("exec-110d")).rejects.toThrow("Firestore sous quota");
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("chemin nominal inchangé (régression)", async () => {
    mocks.set.mockResolvedValue(undefined);
    await expect(createCheckpoint(STATE)).resolves.toBeUndefined();
    await expect(saveCheckpoint(STATE)).resolves.toBeUndefined();
    mocks.get.mockResolvedValue({ exists: false });
    await expect(loadCheckpoint("exec-110d")).resolves.toBeNull();
  });
});

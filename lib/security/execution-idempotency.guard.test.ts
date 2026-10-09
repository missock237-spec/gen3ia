import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde quota de l'idempotence d'exécution (Task 110-e).
 *
 * claimExecutionIdempotency (transaction) est AWAITÉE par executeToolSecurely
 * AVANT chaque outil à risque external/destructive, et
 * completeExecutionIdempotency est awaitée SANS catch après une exécution
 * RÉUSSIE. Sur Firestore brut, sous quota quotidien épuisé, ces écritures
 * pendaient SANS lever (Task 97) : l'étape outil pendait jusqu'à son timeout
 * (120 s par défaut) et un succès pouvait être retenu par sa propre écriture
 * de finalisation. Contrat après fix : touches bornées (6 s) + disjoncteur,
 * sémantique métier inchangée (claim exactement-une-fois, doublon vivant
 * rejeté, replay completed/failed).
 */

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  runTransaction: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ update: mocks.update })),
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
  mocks.update.mockReset();
  mocks.runTransaction.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

import { getQuotaGuardStats, noteFirestoreQuotaError, resetQuotaGuardForTests } from "@/lib/db/quota-guard";
import {
  claimExecutionIdempotency,
  completeExecutionIdempotency,
  failExecutionIdempotency,
} from "./execution-idempotency";

const CLAIM = {
  userId: "user-1",
  toolName: "ads.publish",
  key: "approval-1",
  input: { campaign: "c1" },
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

describe("claimExecutionIdempotency sous garde (110-e)", () => {
  it("VERROU 110-e : disjoncteur ouvert → rejet immédiat, transaction JAMAIS ouverte", async () => {
    openBreaker();
    mocks.runTransaction.mockResolvedValue({ key: "k", state: "processing" });
    await expect(claimExecutionIdempotency(CLAIM)).rejects.toThrow("Firestore sous quota");
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : transaction qui pend → rejet quota-classifié au délai + disjoncteur ouvert", async () => {
    mocks.runTransaction.mockImplementation(() => new Promise(() => undefined)); // stall
    const outcome = await outcomeWithinDeadline(claimExecutionIdempotency(CLAIM));
    expect(outcome).toMatch(/^rejected:/);
    expect(outcome).toContain("quota");
    expect(getQuotaGuardStats().state).toBe("open");
  });

  it("chemin nominal inchangé : claim « processing » sur doc absent (régression)", async () => {
    mocks.runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: vi.fn().mockResolvedValue({ exists: false }),
        create: vi.fn(),
        set: vi.fn(),
      }),
    );
    const claim = await claimExecutionIdempotency(CLAIM);
    expect(claim.state).toBe("processing");
    expect(getQuotaGuardStats().state).toBe("closed");
  });
});

describe("finalisations d'idempotence sous garde (110-e)", () => {
  it("VERROU 110-e : completeExecutionIdempotency, disjoncteur ouvert → rejet immédiat, update JAMAIS émis", async () => {
    openBreaker();
    mocks.update.mockResolvedValue(undefined);
    await expect(completeExecutionIdempotency({ key: "k", result: { ok: true } })).rejects.toThrow("Firestore sous quota");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : failExecutionIdempotency, disjoncteur ouvert → rejet immédiat (les sites .catch restent non bloquants)", async () => {
    openBreaker();
    mocks.update.mockResolvedValue(undefined);
    await expect(failExecutionIdempotency({ key: "k", error: "boom" })).rejects.toThrow("Firestore sous quota");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("chemin nominal inchangé : update émis (régression)", async () => {
    mocks.update.mockResolvedValue(undefined);
    await expect(completeExecutionIdempotency({ key: "k", result: { ok: true } })).resolves.toBeUndefined();
    await expect(failExecutionIdempotency({ key: "k", error: "boom" })).resolves.toBeUndefined();
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });
});

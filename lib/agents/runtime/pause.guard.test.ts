import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde quota des contrôles de pause/arrêt (Task 110-e).
 *
 * requestExecutionPause / requestExecutionStop sont des ÉCRITURES Firestore
 * posées par l'utilisateur : /api/agent/chat/stop (arrêt explicite d'une
 * mission depuis le chat — « le bouton d'arrêt ne répond plus ») et les
 * routes workspace pause/stop. Sur Firestore brut, sous quota quotidien
 * épuisé elles pendaient SANS lever (Task 97) : le bouton d'ARRÊT restait
 * suspendu jusqu'au kill de la fonction — l'utilisateur ne pouvait plus
 * reprendre la main sur un agent en dérive.
 *
 * Contrat après fix : chaque écriture est bornée (6 s) + disjoncteur via le
 * MÊME runFirestoreGuarded que la file de missions (aucune duplication) ;
 * les LECTURES fail-soft (isExecutionPauseRequested / isExecutionStopRequested,
 * catch → false) sont inchangées — elles ne doivent JAMAIS bloquer le runtime.
 */

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ set: mocks.set, get: mocks.get, delete: mocks.delete })),
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
  mocks.delete.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

import { getQuotaGuardStats, noteFirestoreQuotaError, resetQuotaGuardForTests } from "@/lib/db/quota-guard";
import { clearExecutionPause, requestExecutionPause, requestExecutionStop } from "./pause";

const REQUEST = { userId: "user-1", executionId: "exec-110e", reason: "Arrêt demandé par l'utilisateur depuis le chat." };

async function outcomeWithinDeadline(pending: Promise<unknown>): Promise<string> {
  return Promise.race([
    pending.then(
      () => "resolved" as const,
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}` as const,
    ),
    vi.advanceTimersByTimeAsync(7_000).then(() => "timeout" as const),
  ]);
}

describe("contrôles pause/arrêt sous garde (110-e)", () => {
  it("VERROU 110-e : disjoncteur ouvert → requestExecutionStop rejeté immédiatement, Firestore JAMAIS touché", async () => {
    openBreaker();
    mocks.set.mockResolvedValue(undefined);
    await expect(requestExecutionStop(REQUEST)).rejects.toThrow("Firestore sous quota");
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : disjoncteur ouvert → requestExecutionPause rejeté immédiatement (bouton pause plus jamais pendu)", async () => {
    openBreaker();
    await expect(requestExecutionPause(REQUEST)).rejects.toThrow("disjoncteur ouvert");
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : écriture qui pend → rejet quota-classifié au délai (le stop échoue VITE au lieu de pendre 300 s)", async () => {
    mocks.set.mockImplementation(() => new Promise<void>(() => undefined)); // stall
    const outcome = await outcomeWithinDeadline(requestExecutionStop(REQUEST));
    expect(outcome).toMatch(/^rejected:/);
    expect(outcome).toContain("quota");
    expect(getQuotaGuardStats().state).toBe("open");
  });

  it("VERROU 110-e : clearExecutionPause borne la suppression (disjoncteur ouvert → rejet immédiat)", async () => {
    openBreaker();
    mocks.get.mockResolvedValue({ exists: true, get: (key: string) => (key === "userId" ? "user-1" : undefined) });
    await expect(clearExecutionPause("user-1", "exec-110e")).rejects.toThrow("Firestore sous quota");
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("chemin nominal inchangé : contrôle écrit puis supprimé (régression)", async () => {
    mocks.set.mockResolvedValue(undefined);
    await requestExecutionStop(REQUEST);
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(getQuotaGuardStats().state).toBe("closed");

    mocks.get.mockResolvedValue({ exists: true, get: (key: string) => (key === "userId" ? "user-1" : undefined) });
    mocks.delete.mockResolvedValue(undefined);
    await clearExecutionPause("user-1", "exec-110e");
    expect(mocks.delete).toHaveBeenCalledTimes(1);
  });
});

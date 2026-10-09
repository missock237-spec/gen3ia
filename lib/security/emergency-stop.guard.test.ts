import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde quota de l'arrêt d'urgence (Task 110-e).
 *
 * activateEmergencyStop / clearEmergencyStop sont des ÉCRITURES Firestore
 * posées par l'utilisateur via /api/security/emergency-stop — le DERNIER
 * recours pour reprendre la main sur un agent. Sur Firestore brut, sous
 * quota quotidien épuisé, l'écriture pendait SANS lever (Task 97) : le
 * bouton d'urgence restait suspendu jusqu'au kill de la fonction.
 *
 * Contrat après fix : chaque écriture est bornée (6 s) + disjoncteur via le
 * MÊME runFirestoreGuarded que la file de missions (aucune duplication).
 * Les LECTURES (assertExecutionNotStopped, 3 par étape outil) restent
 * brutes : elles lèvent vite sous quota — échec honnête de l'étape, même
 * doctrine que getWallet — et ne doivent JAMAIS masquer un arrêt actif.
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

import { getQuotaGuardStats, noteFirestoreQuotaError, resetQuotaGuardForTests } from "@/lib/db/quota-guard";
import { activateEmergencyStop, clearEmergencyStop } from "./emergency-stop";

const PARAMS = { userId: "user-1", reason: "Urgence : arrêter l'agent." };

async function outcomeWithinDeadline(pending: Promise<unknown>): Promise<string> {
  return Promise.race([
    pending.then(
      () => "resolved" as const,
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}` as const,
    ),
    vi.advanceTimersByTimeAsync(7_000).then(() => "timeout" as const),
  ]);
}

describe("arrêt d'urgence sous garde (110-e)", () => {
  it("VERROU 110-e : disjoncteur ouvert → activateEmergencyStop rejeté immédiatement, Firestore JAMAIS touché", async () => {
    openBreaker();
    mocks.set.mockResolvedValue(undefined);
    await expect(activateEmergencyStop(PARAMS)).rejects.toThrow("Firestore sous quota");
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : écriture qui pend → rejet quota-classifié au délai (le bouton d'urgence répond toujours)", async () => {
    mocks.set.mockImplementation(() => new Promise<void>(() => undefined)); // stall
    const outcome = await outcomeWithinDeadline(activateEmergencyStop(PARAMS));
    expect(outcome).toMatch(/^rejected:/);
    expect(outcome).toContain("quota");
    expect(getQuotaGuardStats().state).toBe("open");
  });

  it("VERROU 110-e : clearEmergencyStop borne la levée (disjoncteur ouvert → rejet immédiat)", async () => {
    openBreaker();
    mocks.get.mockResolvedValue({ exists: false });
    await expect(clearEmergencyStop(PARAMS)).rejects.toThrow("Firestore sous quota");
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("chemin nominal inchangé : arrêt posé puis levé (régression)", async () => {
    mocks.set.mockResolvedValue(undefined);
    await activateEmergencyStop(PARAMS);
    expect(mocks.set).toHaveBeenCalledTimes(1);

    mocks.get.mockResolvedValue({ exists: false });
    await clearEmergencyStop(PARAMS);
    expect(mocks.set).toHaveBeenCalledTimes(2);
    expect(getQuotaGuardStats().state).toBe("closed");
  });
});

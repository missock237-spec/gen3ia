import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde quota de l'audit outil (Task 110-e).
 *
 * recordToolAudit est AWAITÉ par lib/tools/executor AVANT de retourner le
 * RÉSULTAT de l'outil. Sur Firestore brut, sous quota quotidien épuisé,
 * l'écriture pendait SANS lever (Task 97) : un outil RÉUSSI voyait son
 * résultat retenu par l'audit jusqu'au timeout de l'étape (120 s) puis
 * l'étape était marquée échec — travail réel perdu. Contrat après fix :
 * écriture bornée (6 s) + disjoncteur via le MÊME runFirestoreGuarded que
 * la file de missions ; le fail-soft des appelants est conservé mais échoue
 * VITE et le résultat réel est rendu immédiatement.
 */

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ id: "audit-1", set: mocks.set })),
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
});

afterEach(() => {
  vi.useRealTimers();
});

import { getQuotaGuardStats, noteFirestoreQuotaError, resetQuotaGuardForTests } from "@/lib/db/quota-guard";
import { recordToolAudit } from "./audit";

const PARAMS = {
  userId: "user-1",
  executionId: "exec-110e",
  toolId: "artifact.create",
  input: { title: "Rapport" },
  result: {
    callId: "call-1",
    toolId: "artifact.create",
    status: "success" as const,
    output: { ok: true },
    latencyMs: 42,
    executedAt: new Date().toISOString(),
  },
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

describe("audit outil sous garde (110-e)", () => {
  it("VERROU 110-e : disjoncteur ouvert → rejet immédiat, écriture JAMAIS émise", async () => {
    openBreaker();
    mocks.set.mockResolvedValue(undefined);
    await expect(recordToolAudit(PARAMS)).rejects.toThrow("Firestore sous quota");
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : écriture qui pend → rejet au délai (le résultat d'un outil réussi n'est plus retenu par l'audit)", async () => {
    mocks.set.mockImplementation(() => new Promise<void>(() => undefined)); // stall
    const outcome = await outcomeWithinDeadline(recordToolAudit(PARAMS));
    expect(outcome).toMatch(/^rejected:/);
    expect(outcome).toContain("quota");
    expect(getQuotaGuardStats().state).toBe("open");
  });

  it("chemin nominal inchangé : audit écrit, id renvoyé (régression)", async () => {
    mocks.set.mockResolvedValue(undefined);
    const id = await recordToolAudit(PARAMS);
    expect(id).toBe("audit-1");
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(getQuotaGuardStats().state).toBe("closed");
  });
});

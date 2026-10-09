import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde quota de la piste d'audit sécurité (Task 110-e).
 *
 * appendSecurityAuditEvent est AWAITÉE par executeToolSecurely AVANT chaque
 * étape outil de mission (« authorized », « started »). Sur Firestore brut,
 * sous quota quotidien épuisé l'écriture pendaît SANS lever (Task 97) :
 * chaque étape outil de mission pendait jusqu'à son timeout (120 s par
 * défaut) puis échouait. Contrat après fix : écriture bornée (6 s) +
 * disjoncteur via le MÊME runFirestoreGuarded que la file de missions — les
 * sites non bloquants (.catch) le restent, les sites bloquants échouent
 * vite et quota-classifié.
 */

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ create: mocks.create })),
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
  mocks.create.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

import { getQuotaGuardStats, noteFirestoreQuotaError, resetQuotaGuardForTests } from "@/lib/db/quota-guard";
import { appendSecurityAuditEvent } from "./security-audit";

const EVENT = {
  userId: "user-1",
  executionId: "exec-110e",
  toolName: "web.api.write",
  event: "authorized" as const,
  risk: "external",
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

describe("appendSecurityAuditEvent sous garde (110-e)", () => {
  it("VERROU 110-e : disjoncteur ouvert → rejet immédiat, écriture JAMAIS émise", async () => {
    openBreaker();
    mocks.create.mockResolvedValue(undefined);
    await expect(appendSecurityAuditEvent(EVENT)).rejects.toThrow("Firestore sous quota");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : écriture qui pend → rejet quota-classifié au délai (étape outil plus jamais pendue 120 s)", async () => {
    mocks.create.mockImplementation(() => new Promise<void>(() => undefined)); // stall
    const outcome = await outcomeWithinDeadline(appendSecurityAuditEvent(EVENT));
    expect(outcome).toMatch(/^rejected:/);
    expect(outcome).toContain("quota");
    expect(getQuotaGuardStats().state).toBe("open");
  });

  it("chemin nominal inchangé : événement écrit, id renvoyé (régression)", async () => {
    mocks.create.mockResolvedValue(undefined);
    const id = await appendSecurityAuditEvent(EVENT);
    expect(id).toEqual(expect.any(String));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(getQuotaGuardStats().state).toBe("closed");
  });
});

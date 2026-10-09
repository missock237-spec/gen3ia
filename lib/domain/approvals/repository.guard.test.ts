import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde quota des approbations de conversation workspace (Task 110-e).
 *
 * Les approbations `conversationApprovals` sont les validations HITL du
 * MOTEUR DE CONVERSATION workspace (lib/domain/conversations/engine.ts —
 * createApproval pendant un streaming quand une étape outil exige une
 * validation) et de leur centre de décision (decideApproval — transaction,
 * appelé depuis la conversation ET le centre de notifications). Sur Firestore
 * brut, sous quota quotidien épuisé, l'écriture pendait SANS lever (Task 97)
 * : le streaming restait suspendu à l'étape sensible et la décision de
 * validation pendait.
 *
 * Contrat après fix : chaque écriture est bornée (6 s) + disjoncteur via le
 * MÊME runFirestoreGuarded que la file de missions (aucune duplication).
 */

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  runTransaction: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ id: "approval-1", set: mocks.set })),
    })),
    runTransaction: mocks.runTransaction,
  },
}));

vi.mock("@/lib/notifications/repository", () => ({
  createNotification: vi.fn(async () => undefined),
  markNotificationsForApprovalRead: vi.fn(async () => undefined),
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
  mocks.runTransaction.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

import { getQuotaGuardStats, noteFirestoreQuotaError, resetQuotaGuardForTests } from "@/lib/db/quota-guard";
import { createApproval, decideApproval } from "./repository";

const INPUT = {
  userId: "user-1",
  conversationId: "conv-1",
  runId: "run-1",
  stepId: "step-1",
  toolName: "ads.publish",
  title: "Publication publicitaire",
  impact: "Budget engage",
  dataScope: "campagne c1",
  estimatedCost: "~1 000 XAF",
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

describe("approbations de conversation sous garde (110-e)", () => {
  it("VERROU 110-e : disjoncteur ouvert → createApproval rejeté immédiatement, Firestore JAMAIS touché", async () => {
    openBreaker();
    mocks.set.mockResolvedValue(undefined);
    await expect(createApproval(INPUT)).rejects.toThrow("Firestore sous quota");
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : disjoncteur ouvert → decideApproval rejeté immédiatement, transaction JAMAIS ouverte", async () => {
    openBreaker();
    mocks.runTransaction.mockResolvedValue({ approval: { ...INPUT, id: "approval-1", status: "approved" }, alreadyDecided: false });
    await expect(decideApproval("user-1", "approval-1", "approved")).rejects.toThrow("disjoncteur ouvert");
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : création qui pend → rejet quota-classifié au délai (streaming plus jamais suspendu 300 s)", async () => {
    mocks.set.mockImplementation(() => new Promise<void>(() => undefined)); // stall
    const outcome = await outcomeWithinDeadline(createApproval(INPUT));
    expect(outcome).toMatch(/^rejected:/);
    expect(outcome).toContain("quota");
    expect(getQuotaGuardStats().state).toBe("open");
  });

  it("chemin nominal inchangé : approbation créée puis décidée (régression)", async () => {
    mocks.set.mockResolvedValue(undefined);
    const created = await createApproval(INPUT);
    expect(created.id).toBe("approval-1");
    expect(created.status).toBe("pending");
    expect(mocks.set).toHaveBeenCalledTimes(1);

    mocks.runTransaction.mockResolvedValue({ approval: { ...INPUT, id: "approval-1", status: "approved" }, alreadyDecided: false });
    const decision = await decideApproval("user-1", "approval-1", "approved");
    expect(decision.approval.status).toBe("approved");
    expect(decision.alreadyDecided).toBe(false);
    expect(getQuotaGuardStats().state).toBe("closed");
  });
});

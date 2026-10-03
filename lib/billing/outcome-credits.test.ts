import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Avoir automatique « mission échouée sous contrat de résultat » (concept
 * #2) : décision pure (seulement contrat présent + échec), montant réels
 * plafonné (GEN3IA_OUTCOME_CREDIT_CAP_EUR), idempotence par exécution
 * (document de journal unique), type de journal conforme au schéma wallet
 * (« refund »), et fail-soft total (une panne d'avoir ne change jamais
 * l'issue d'une mission).
 */

const walletDoc = { get: vi.fn(), set: vi.fn(), create: vi.fn() };
const ledgerDoc = { get: vi.fn(), set: vi.fn(), create: vi.fn() };
const runTransaction = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  FieldValue: {
    delete: () => ({ __delete: true }),
    serverTimestamp: () => ({ __serverTimestamp: true }),
  },
  adminDb: {
    collection: vi.fn((name: string) => ({
      doc: vi.fn(() => (name === "userWallets" ? walletDoc : ledgerDoc)),
    })),
    runTransaction: (...args: unknown[]) => runTransaction(...args),
  },
}));
vi.mock("./wallet", () => ({
  getWallet: vi.fn(async () => ({
    userId: "u1", currency: "XAF", balanceMinor: 42_000, reservedMinor: 0, availableMinor: 42_000, updatedAt: 0, welcomeGranted: true, welcomeAmountMinor: 0,
  })),
  WALLET_CURRENCY: "XAF",
}));

import {
  applyOutcomeCredit,
  outcomeCreditCapMinor,
  shouldCreditOutcomeFailure,
} from "./outcome-credits";

function inTransaction() {
  runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<boolean>) =>
    fn({
      get: (ref: { get: () => Promise<unknown> }) => ref.get(),
      // Le tx réel reçoit les références : on les retire pour les assertions.
      set: (_ref: unknown, data: unknown, opts: unknown) => walletDoc.set(data, opts),
      create: (_ref: unknown, data: unknown) => ledgerDoc.create(data),
    }));
}

beforeEach(() => {
  walletDoc.get.mockReset();
  walletDoc.set.mockReset();
  walletDoc.create.mockReset();
  ledgerDoc.get.mockReset();
  ledgerDoc.set.mockReset();
  ledgerDoc.create.mockReset();
  runTransaction.mockReset();
  delete process.env.GEN3IA_OUTCOME_CREDIT_CAP_EUR;
});

describe("décision d'avoir (pure)", () => {
  it("un avoir n'est dû que si un contrat est présent ET la mission en échec", () => {
    expect(shouldCreditOutcomeFailure({ contractPresent: true, missionStatus: "failed" })).toBe(true);
    expect(shouldCreditOutcomeFailure({ contractPresent: false, missionStatus: "failed" })).toBe(false);
    expect(shouldCreditOutcomeFailure({ contractPresent: true, missionStatus: "completed" })).toBe(false);
    expect(shouldCreditOutcomeFailure({ contractPresent: true, missionStatus: "cancelled" })).toBe(false);
    expect(shouldCreditOutcomeFailure({ contractPresent: true, missionStatus: "paused" })).toBe(false);
  });
});

describe("plafond d'avoir", () => {
  it("défaut 5 EUR (500 minor)", () => {
    expect(outcomeCreditCapMinor()).toBe(500);
  });
  it("surcharge par variable d'environnement", () => {
    process.env.GEN3IA_OUTCOME_CREDIT_CAP_EUR = "2.5";
    expect(outcomeCreditCapMinor()).toBe(250);
  });
  it("valeur invalide → repli sur le défaut", () => {
    process.env.GEN3IA_OUTCOME_CREDIT_CAP_EUR = "NaN";
    expect(outcomeCreditCapMinor()).toBe(500);
    process.env.GEN3IA_OUTCOME_CREDIT_CAP_EUR = "-3";
    expect(outcomeCreditCapMinor()).toBe(500);
  });
});

describe("applyOutcomeCredit", () => {
  it("frais nuls/absents → aucun avoir demandé (zéro écriture)", async () => {
    const result = await applyOutcomeCredit({ userId: "u1", executionId: "e1", totalChargeMinor: 0 });
    expect(result.credited).toBe(false);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it("montant = min(frais réels, plafond) et écriture de journal type « refund »", async () => {
    walletDoc.get.mockResolvedValue({ exists: false, get: () => 0 });
    ledgerDoc.get.mockResolvedValue({ exists: false });
    inTransaction();
    const result = await applyOutcomeCredit({ userId: "u1", executionId: "e2", totalChargeMinor: 9_000, missionStatus: "failed" });
    expect(result.credited).toBe(true);
    expect(result.amountMinor).toBe(500); // plafond 5 EUR
    expect(walletDoc.set).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", currency: "XAF", balanceMinor: 500 }),
      { merge: true },
    );
    const ledgerEntry = ledgerDoc.create.mock.calls[0][0];
    expect(ledgerEntry.type).toBe("refund");
    expect(ledgerEntry.providerReference).toBe("e2");
    expect(ledgerEntry.metadata.reason).toBe("mission_failed_outcome_contract");
    expect(ledgerEntry.metadata.missionStatus).toBe("failed");
  });

  it("frais inférieurs au plafond → avoir sur les frais réels", async () => {
    walletDoc.get.mockResolvedValue({ exists: true, get: (field: string) => (field === "balanceMinor" ? 10_000 : field === "reservedMinor" ? 0 : 0) });
    ledgerDoc.get.mockResolvedValue({ exists: false });
    inTransaction();
    const result = await applyOutcomeCredit({ userId: "u1", executionId: "e3", totalChargeMinor: 120 });
    expect(result.credited).toBe(true);
    expect(result.amountMinor).toBe(120);
    expect(walletDoc.set).toHaveBeenCalledWith(
      expect.objectContaining({ balanceMinor: 10_120, reservedMinor: 0 }),
      { merge: true },
    );
  });

  it("IDEMPOTENCE : un avoir existant pour l'exécution n'est jamais doublé", async () => {
    ledgerDoc.get.mockResolvedValue({ exists: true });
    inTransaction();
    const result = await applyOutcomeCredit({ userId: "u1", executionId: "e4", totalChargeMinor: 9_000 });
    expect(result.credited).toBe(false);
    expect(walletDoc.set).not.toHaveBeenCalled();
    expect(ledgerDoc.create).not.toHaveBeenCalled();
  });

  it("panne d'infrastructure → fail-soft (jamais d'exception, credited=false)", async () => {
    runTransaction.mockRejectedValue(new Error("firestore indisponible"));
    const result = await applyOutcomeCredit({ userId: "u1", executionId: "e5", totalChargeMinor: 300 });
    expect(result.credited).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

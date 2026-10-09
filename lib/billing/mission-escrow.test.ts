import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ESCROW DE MISSION (V2 — Task 114-a) : décision pure (capture si réussite
 * avec hold actif/absent, libération si échec avec hold, skip sinon), frais
 * de résultat borné (env, clamp ≥ 0, plafond), registre walletHolds, et
 * fail-soft total (aucun échec d'escrow ne bloque une mission).
 *
 *Mocks adminDb selon le pattern mission-queue.guard.test.ts / outcome-credits.test.ts.
 */

const mocks = vi.hoisted(() => {
  const holdDoc = { get: vi.fn(), set: vi.fn() };
  const queryGet = vi.fn();
  return {
    holdDoc,
    queryGet,
    collection: vi.fn((_name: string) => ({
      doc: vi.fn(() => holdDoc),
      where: vi.fn(() => ({
        limit: vi.fn(() => ({ get: queryGet })),
      })),
    })),
    reserveFunds: vi.fn(),
    settleReservation: vi.fn(),
    releaseReservation: vi.fn(),
  };
});

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: mocks.collection,
  },
}));

vi.mock("./wallet", () => ({
  reserveFunds: mocks.reserveFunds,
  settleReservation: mocks.settleReservation,
  releaseReservation: mocks.releaseReservation,
}));

import {
  captureMissionEscrow,
  decideEscrowAction,
  missionResultFeeMinor,
  releaseExpiredEscrows,
  reserveMissionEscrow,
} from "./mission-escrow";

function heldDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    executionId: "e1",
    userId: "u1",
    reference: "escrow_e1",
    state: "held",
    amountMinor: 5000,
    createdAtMs: 1,
    expiresAtMs: Date.now() + 86_400_000,
    updatedAtMs: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.holdDoc.get.mockReset();
  mocks.holdDoc.set.mockReset();
  mocks.queryGet.mockReset();
  mocks.collection.mockClear();
  mocks.reserveFunds.mockReset().mockResolvedValue({});
  mocks.settleReservation.mockReset().mockResolvedValue({});
  mocks.releaseReservation.mockReset().mockResolvedValue({});
  delete process.env.GEN3IA_MISSION_RESULT_FEE_MINOR;
  delete process.env.GEN3IA_MISSION_RESULT_FEE_MAX_MINOR;
  delete process.env.GEN3IA_ESCROW_TTL_MS;
});

describe("missionResultFeeMinor (pur)", () => {
  it("défaut 5 000 minor (50 FCFA)", () => {
    expect(missionResultFeeMinor()).toBe(5000);
  });
  it("surcharge par variable d'environnement", () => {
    process.env.GEN3IA_MISSION_RESULT_FEE_MINOR = "12345";
    expect(missionResultFeeMinor()).toBe(12345);
  });
  it("clamp ≥ 0 : valeur négative ou invalide → 0 / défaut", () => {
    process.env.GEN3IA_MISSION_RESULT_FEE_MINOR = "-200";
    expect(missionResultFeeMinor()).toBe(0);
    process.env.GEN3IA_MISSION_RESULT_FEE_MINOR = "NaN";
    expect(missionResultFeeMinor()).toBe(5000);
  });
  it("plafond : valeur au-dessus du cap est bornée (cap défaut 50 000)", () => {
    process.env.GEN3IA_MISSION_RESULT_FEE_MINOR = "999999";
    expect(missionResultFeeMinor()).toBe(50000);
    process.env.GEN3IA_MISSION_RESULT_FEE_MAX_MINOR = "8000";
    expect(missionResultFeeMinor()).toBe(8000);
  });
});

describe("decideEscrowAction (pur — table complète)", () => {
  it("completed → capture si hold actif (« held » ou absent), skip sinon", () => {
    expect(decideEscrowAction({ missionStatus: "completed", holdState: "held" }).action).toBe("capture");
    expect(decideEscrowAction({ missionStatus: "completed" }).action).toBe("capture");
    expect(decideEscrowAction({ missionStatus: "completed", holdState: "captured" }).action).toBe("skip");
    expect(decideEscrowAction({ missionStatus: "completed", holdState: "released" }).action).toBe("skip");
  });

  it("failed/cancelled → release si hold « held », skip sinon", () => {
    expect(decideEscrowAction({ missionStatus: "failed", holdState: "held" }).action).toBe("release");
    expect(decideEscrowAction({ missionStatus: "cancelled", holdState: "held" }).action).toBe("release");
    expect(decideEscrowAction({ missionStatus: "failed" }).action).toBe("skip");
    expect(decideEscrowAction({ missionStatus: "cancelled", holdState: "captured" }).action).toBe("skip");
    expect(decideEscrowAction({ missionStatus: "failed", holdState: "released" }).action).toBe("skip");
  });

  it("statuts non terminaux → toujours skip (décision reportée au tick final)", () => {
    for (const status of ["queued", "running", "paused", "pending"]) {
      expect(decideEscrowAction({ missionStatus: status, holdState: "held" }).action).toBe("skip");
      expect(decideEscrowAction({ missionStatus: status }).action).toBe("skip");
    }
  });
});

describe("reserveMissionEscrow", () => {
  it("frais nul (escrow désactivé) → ok sans aucune écriture", async () => {
    process.env.GEN3IA_MISSION_RESULT_FEE_MINOR = "0";
    const result = await reserveMissionEscrow({ userId: "u1", executionId: "e1" });
    expect(result).toMatchObject({ ok: true, holdMinor: 0 });
    expect(mocks.reserveFunds).not.toHaveBeenCalled();
    expect(mocks.collection).not.toHaveBeenCalled();
  });

  it("réservation nominale : wallet réservé + registre walletHolds écrit", async () => {
    const result = await reserveMissionEscrow({ userId: "u1", executionId: "e1", runId: "r1" });
    expect(result).toMatchObject({ ok: true, holdMinor: 5000 });
    expect(mocks.reserveFunds).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        amountMinor: 5000,
        reference: "escrow_e1",
        metadata: expect.objectContaining({ kind: "mission_escrow", runId: "r1" }),
      }),
    );
    expect(mocks.holdDoc.set).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "e1",
        userId: "u1",
        reference: "escrow_e1",
        state: "held",
        amountMinor: 5000,
      }),
      { merge: true },
    );
  });

  it("fonds insuffisants → ok:false sans throw NI écriture de registre", async () => {
    mocks.reserveFunds.mockRejectedValue(new Error("Insufficient wallet balance for this execution."));
    const result = await reserveMissionEscrow({ userId: "u1", executionId: "e1" });
    expect(result).toMatchObject({ ok: false, reason: "insufficient_funds" });
    expect(mocks.holdDoc.set).not.toHaveBeenCalled();
  });

  it("panne d'infrastructure de la réservation → fail-soft (ok:true, mission non bloquée)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.reserveFunds.mockRejectedValue(new Error("r2fs indisponible"));
    const result = await reserveMissionEscrow({ userId: "u1", executionId: "e1" });
    expect(result.ok).toBe(true);
    expect(result.holdMinor).toBe(0);
    consoleError.mockRestore();
  });
});

describe("captureMissionEscrow", () => {
  it("completed avec hold → settleReservation au montant du registre + état « captured »", async () => {
    mocks.holdDoc.get.mockResolvedValue({ exists: true, data: () => heldDoc() });
    const result = await captureMissionEscrow({ userId: "u1", executionId: "e1", missionStatus: "completed", runId: "r1" });
    expect(result.action).toBe("captured");
    expect(mocks.settleReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        reference: "escrow_e1",
        reservedMinor: 5000,
        actualChargeMinor: 5000,
        metadata: expect.objectContaining({ kind: "mission_escrow", missionStatus: "completed" }),
      }),
    );
    expect(mocks.holdDoc.set).toHaveBeenCalledWith(
      expect.objectContaining({ state: "captured", missionStatus: "completed" }),
      { merge: true },
    );
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
  });

  it("completed SANS registre → rattrapage (reserve+settle au frais courant) + registre « captured »", async () => {
    mocks.holdDoc.get.mockResolvedValue({ exists: false, data: () => undefined });
    const result = await captureMissionEscrow({ userId: "u1", executionId: "e1", missionStatus: "completed" });
    expect(result.action).toBe("captured");
    expect(mocks.reserveFunds).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", amountMinor: 5000, reference: "escrow_e1" }),
    );
    expect(mocks.settleReservation).toHaveBeenCalledWith(
      expect.objectContaining({ reference: "escrow_e1", reservedMinor: 5000, actualChargeMinor: 5000 }),
    );
    expect(mocks.holdDoc.set).toHaveBeenCalledWith(expect.objectContaining({ state: "captured" }), { merge: true });
  });

  it("completed SANS registre ET escrow désactivé → skip (aucun débit)", async () => {
    process.env.GEN3IA_MISSION_RESULT_FEE_MINOR = "0";
    mocks.holdDoc.get.mockResolvedValue({ exists: false, data: () => undefined });
    const result = await captureMissionEscrow({ userId: "u1", executionId: "e1", missionStatus: "completed" });
    expect(result.action).toBe("skipped");
    expect(mocks.reserveFunds).not.toHaveBeenCalled();
    expect(mocks.settleReservation).not.toHaveBeenCalled();
  });

  it("failed avec hold → releaseReservation + registre « released »", async () => {
    mocks.holdDoc.get.mockResolvedValue({ exists: true, data: () => heldDoc() });
    const result = await captureMissionEscrow({ userId: "u1", executionId: "e1", missionStatus: "failed" });
    expect(result.action).toBe("released");
    expect(mocks.releaseReservation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", reference: "escrow_e1", reservedMinor: 5000 }),
    );
    expect(mocks.settleReservation).not.toHaveBeenCalled();
    expect(mocks.holdDoc.set).toHaveBeenCalledWith(expect.objectContaining({ state: "released" }), { merge: true });
  });

  it("IDEMPOTENCE : double capture (registre déjà « captured ») → skip, wallet JAMAIS touché", async () => {
    mocks.holdDoc.get.mockResolvedValue({ exists: true, data: () => heldDoc({ state: "captured", capturedAtMs: 2 }) });
    const result = await captureMissionEscrow({ userId: "u1", executionId: "e1", missionStatus: "completed" });
    expect(result.action).toBe("captured");
    expect(result.reason).toMatch(/idempotence/i);
    expect(mocks.settleReservation).not.toHaveBeenCalled();
    expect(mocks.reserveFunds).not.toHaveBeenCalled();
  });

  it("IDEMPOTENCE : double libération (registre déjà « released ») → skip", async () => {
    mocks.holdDoc.get.mockResolvedValue({ exists: true, data: () => heldDoc({ state: "released" }) });
    const result = await captureMissionEscrow({ userId: "u1", executionId: "e1", missionStatus: "failed" });
    expect(result.action).toBe("released");
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
  });

  it("échec SANS registre → skip (rien à libérer)", async () => {
    mocks.holdDoc.get.mockResolvedValue({ exists: false, data: () => undefined });
    const result = await captureMissionEscrow({ userId: "u1", executionId: "e1", missionStatus: "failed" });
    expect(result.action).toBe("skipped");
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
  });

  it("statut non terminal (paused) → skip, wallet JAMAIS touché (le hold attend le tick final)", async () => {
    mocks.holdDoc.get.mockResolvedValue({ exists: true, data: () => heldDoc() });
    const result = await captureMissionEscrow({ userId: "u1", executionId: "e1", missionStatus: "paused" });
    expect(result.action).toBe("skipped");
    expect(mocks.settleReservation).not.toHaveBeenCalled();
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
  });

  it("panne d'infrastructure → fail-soft (jamais de throw, action « skipped »)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.holdDoc.get.mockRejectedValue(new Error("r2fs indisponible"));
    const result = await captureMissionEscrow({ userId: "u1", executionId: "e1", missionStatus: "completed" });
    expect(result.action).toBe("skipped");
    expect(result.reason).toBeTruthy();
    consoleError.mockRestore();
  });

  it("settle déjà joué (conflit ledger) → fail-soft, registre inchangé, jamais de throw", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.holdDoc.get.mockResolvedValue({ exists: true, data: () => heldDoc() });
    mocks.settleReservation.mockRejectedValue(new Error("r2fs: document créé concurremment (settlement_escrow_e1)"));
    const result = await captureMissionEscrow({ userId: "u1", executionId: "e1", missionStatus: "completed" });
    expect(result.action).toBe("skipped");
    consoleError.mockRestore();
  });
});

describe("releaseExpiredEscrows (reaper TTL)", () => {
  it("hold expiré → libéré + registre « released », compte rendu 1", async () => {
    mocks.queryGet.mockResolvedValue({
      docs: [{ id: "e1", data: () => heldDoc({ expiresAtMs: Date.now() - 1000 }) }],
    });
    const released = await releaseExpiredEscrows(50);
    expect(released).toBe(1);
    expect(mocks.releaseReservation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", reference: "escrow_e1", reservedMinor: 5000 }),
    );
    expect(mocks.holdDoc.set).toHaveBeenCalledWith(expect.objectContaining({ state: "released", missionStatus: "expired" }), { merge: true });
  });

  it("hold non expiré → ignoré (0 libération)", async () => {
    mocks.queryGet.mockResolvedValue({
      docs: [{ id: "e1", data: () => heldDoc({ expiresAtMs: Date.now() + 86_400_000 }) }],
    });
    expect(await releaseExpiredEscrows(50)).toBe(0);
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
  });

  it("panne de la requête → fail-soft (0, jamais de throw)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.queryGet.mockRejectedValue(new Error("r2fs indisponible"));
    expect(await releaseExpiredEscrows(50)).toBe(0);
    consoleError.mockRestore();
  });
});

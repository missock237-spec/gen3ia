import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MODE LIBRE (GEN3IA_BILLING_ENABLED=false) — migration R2 totale :
 * la plateforme ne facture plus l'usage. Contrat testé :
 *
 *  1. wallet.ts     — reserveFunds / settleReservation / releaseReservation
 *                     deviennent des no-ops (aucune transaction R2, aucun
 *                     throw) et assertWalletActive ne bloque JAMAIS ;
 *  2. media-meter   — billUsage ne débite plus (chargeMinor 0, aucun accès
 *                     wallet, aucun blocage « solde insuffisant ») ;
 *  3. ai-execution  — generateForUser appelle le LLM sans réserver ;
 *  4. tool-meter    — reserveToolExecution ne bloque pas et réserve 0 ;
 *  5. mission-escrow— la mission démarre sans frais de résultat ;
 *  6. video/credits — images et TTS ne sont pas facturés.
 *
 * CONTRAINTE : BILLING_ENABLED est une constante de module lue à l'import —
 * l'environnement doit être posé AVANT tout import dynamique des modules
 * (jamais d'import statique au top-level de ce fichier).
 */

const mocks = vi.hoisted(() => {
  const walletDoc = { get: vi.fn(), set: vi.fn(), update: vi.fn() };
  const ledgerDoc = { get: vi.fn(), set: vi.fn(), create: vi.fn() };
  const txMock = {
    get: vi.fn(),
    set: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const collection = vi.fn((name: string) => ({
    doc: vi.fn(() => (name === "userWallets" ? walletDoc : ledgerDoc)),
    where: vi.fn(() => ({ limit: vi.fn(() => ({ get: vi.fn(async () => ({ docs: [] })) })) })),
  }));
  return {
    walletDoc,
    ledgerDoc,
    txMock,
    collection,
    runTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
    generate: vi.fn(),
    selectProvider: vi.fn(() => []),
  };
});

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: mocks.collection, runTransaction: mocks.runTransaction },
}));

vi.mock("@/lib/ai/router", () => ({
  generate: mocks.generate,
  selectProvider: mocks.selectProvider,
}));

// AVANT tout import de module de facturation (les imports sont dynamiques).
process.env.GEN3IA_BILLING_ENABLED = "false";

beforeEach(() => {
  mocks.walletDoc.get.mockReset().mockResolvedValue({ exists: false });
  mocks.walletDoc.set.mockReset().mockResolvedValue(undefined);
  mocks.walletDoc.update.mockReset().mockResolvedValue(undefined);
  mocks.ledgerDoc.get.mockReset().mockResolvedValue({ exists: false });
  mocks.ledgerDoc.set.mockReset().mockResolvedValue(undefined);
  mocks.ledgerDoc.create.mockReset().mockResolvedValue(undefined);
  mocks.txMock.get.mockReset().mockResolvedValue({ exists: false });
  mocks.txMock.set.mockReset().mockResolvedValue(undefined);
  mocks.txMock.create.mockReset().mockResolvedValue(undefined);
  mocks.txMock.update.mockReset().mockResolvedValue(undefined);
  mocks.collection.mockClear();
  mocks.runTransaction.mockClear();
  mocks.generate.mockReset().mockResolvedValue({
    provider: "groq",
    model: "llama-test",
    text: "réponse libre",
    usage: { inputTokens: 10, outputTokens: 20 },
    latencyMs: 5,
  });
  mocks.selectProvider.mockClear().mockReturnValue([]);
});

describe("Mode libre — wallet (no-ops)", () => {
  it("BILLING_ENABLED=false est bien actif", async () => {
    const billingMode = await import("./billing-mode");
    expect(billingMode.BILLING_ENABLED).toBe(false);
  });

  it("reserveFunds : aucune transaction, aucun throw, snapshot retourné", async () => {
    const wallet = await import("./wallet");
    const snapshot = await wallet.reserveFunds({ userId: "u1", amountMinor: 5000, reference: "r1" });
    expect(mocks.runTransaction).not.toHaveBeenCalled();
    expect(snapshot.userId).toBe("u1");
    // Wallet illisible (R2 en panne) : snapshot neutre, jamais de throw.
    mocks.walletDoc.get.mockRejectedValueOnce(new Error("R2 down"));
    const degraded = await wallet.reserveFunds({ userId: "u2", amountMinor: 1, reference: "r2" });
    expect(degraded.availableMinor).toBe(0);
  });

  it("settleReservation / releaseReservation : no-ops sans throw", async () => {
    const wallet = await import("./wallet");
    await expect(wallet.settleReservation({ userId: "u1", reference: "r1", reservedMinor: 100, actualChargeMinor: 60 })).resolves.toBeDefined();
    await expect(wallet.releaseReservation({ userId: "u1", reference: "r1", reservedMinor: 100 })).resolves.toBeDefined();
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("assertWalletActive : jamais de blocage, même à solde 0", async () => {
    const wallet = await import("./wallet");
    expect(() =>
      wallet.assertWalletActive({
        userId: "u1",
        currency: "XAF",
        balanceMinor: 0,
        reservedMinor: 0,
        availableMinor: 0,
        updatedAt: Date.now(),
        welcomeGranted: false,
        welcomeAmountMinor: 0,
      }),
    ).not.toThrow();
  });
});

describe("Mode libre — media-meter (billUsage)", () => {
  it("aucun débit, aucun accès wallet, chargeMinor 0", async () => {
    const mediaMeter = await import("./media-meter");
    const result = await mediaMeter.billUsage({ userId: "u1", executionId: "e1", kind: "image_generation", quantity: 3 });
    expect(result.chargeMinor).toBe(0);
    expect(result.reserveMinor).toBe(0);
    expect(mocks.runTransaction).not.toHaveBeenCalled();
    expect(mocks.collection).not.toHaveBeenCalledWith("userWallets");
  });

  it("une quantité invalide reste une erreur de programmation", async () => {
    const mediaMeter = await import("./media-meter");
    await expect(mediaMeter.billUsage({ userId: "u1", executionId: "e1", kind: "tts", quantity: 0 })).rejects.toThrow(/positive/);
  });
});

describe("Mode libre — ai-execution (generateForUser)", () => {
  it("génère directement sans réservation ni débit", async () => {
    const aiExecution = await import("./ai-execution");
    const billed = await aiExecution.generateForUser({
      userId: "u1",
      executionId: "exec1",
      request: { task: "chat", messages: [{ role: "user", content: "Bonjour" }] } as never,
    });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(billed.chargeMinor).toBe(0);
    expect(billed.providerCostEur).toBe(0);
    expect(billed.response.text).toBe("réponse libre");
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });
});

describe("Mode libre — tool-meter", () => {
  it("reserveToolExecution : aucun blocage, réserve 0", async () => {
    const toolMeter = await import("./tool-meter");
    const reservation = await toolMeter.reserveToolExecution({
      userId: "u1",
      executionId: "e1",
      toolName: "web.search",
      input: { query: "test" },
    });
    expect(reservation.reserveMinor).toBe(0);
    expect(reservation.estimate.chargeMinor).toBe(0);
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("settleToolExecution / releaseToolExecution : no-ops", async () => {
    const toolMeter = await import("./tool-meter");
    const settled = await toolMeter.settleToolExecution({
      userId: "u1",
      toolName: "web.search",
      input: { query: "test" },
      durationMs: 120,
      reference: "free_x",
      reserveMinor: 0,
    });
    expect(settled.chargeMinor).toBe(0);
    await expect(
      toolMeter.releaseToolExecution({ userId: "u1", reference: "free_x", reserveMinor: 0 }),
    ).resolves.toBeUndefined();
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });
});

describe("Mode libre — mission-escrow", () => {
  it("la mission démarre sans frais de résultat ni registre", async () => {
    const escrow = await import("./mission-escrow");
    const reservation = await escrow.reserveMissionEscrow({ userId: "u1", executionId: "e1" });
    expect(reservation.ok).toBe(true);
    expect(reservation.holdMinor).toBe(0);
    expect(mocks.collection).not.toHaveBeenCalledWith("walletHolds");
  });

  it("captureMissionEscrow : skip immédiat, releaseExpiredEscrows : 0", async () => {
    const escrow = await import("./mission-escrow");
    const capture = await escrow.captureMissionEscrow({ userId: "u1", executionId: "e1", missionStatus: "completed" });
    expect(capture.action).toBe("skipped");
    expect(mocks.collection).not.toHaveBeenCalledWith("walletHolds");
    await expect(escrow.releaseExpiredEscrows()).resolves.toBe(0);
  });
});

describe("Mode libre — vidéo (credits)", () => {
  it("images et TTS ne sont pas facturés (retour 0)", async () => {
    const credits = await import("@/lib/video/credits");
    await expect(credits.billImageGeneration("u1", "p1", 4)).resolves.toBe(0);
    await expect(credits.billTts("u1", "p1", 900)).resolves.toBe(0);
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("le budget de rendu se réserve/solde sans erreur ni écriture", async () => {
    const credits = await import("@/lib/video/credits");
    const estimate = credits.estimateRenderCost({ durationSec: 30, resolution: "1080p" });
    await expect(credits.reserveRenderBudget("u1", "job1", estimate)).resolves.toBeUndefined();
    await expect(credits.settleRenderBudget({ userId: "u1", jobId: "job1", estimate, actualDurationSec: 28 })).resolves.toBeDefined();
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });
});

describe("Mode libre — outcome-credits", () => {
  it("aucun avoir appliqué (aucun frais n'a été débité)", async () => {
    const outcome = await import("./outcome-credits");
    const result = await outcome.applyOutcomeCredit({ userId: "u1", executionId: "e1", totalChargeMinor: 500 });
    expect(result.credited).toBe(false);
    expect(result.amountMinor).toBe(0);
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });
});

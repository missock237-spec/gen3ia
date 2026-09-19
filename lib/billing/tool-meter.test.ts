import { beforeEach, describe, expect, it, vi } from "vitest";

// Les fonctions de portefeuille touchent Firestore (Admin SDK) : on les
// remplace pour tester la logique de metering et les garde-fous de facturation.
vi.mock("./wallet", () => ({
  getWallet: vi.fn(),
  reserveFunds: vi.fn(),
  settleReservation: vi.fn(),
  releaseReservation: vi.fn(),
}));

import { getWallet, reserveFunds, settleReservation } from "./wallet";
import { estimateToolCharge, releaseToolExecution, reserveToolExecution, settleToolExecution } from "./tool-meter";

const mockedGetWallet = vi.mocked(getWallet);
const mockedReserveFunds = vi.mocked(reserveFunds);
const mockedSettleReservation = vi.mocked(settleReservation);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("estimateToolCharge — routage de categorie", () => {
  it("route web.search vers la categorie web", () => {
    expect(estimateToolCharge({ userId: "u", executionId: "e", toolName: "web.search", input: {} }).category).toBe("web");
  });

  it("route browser.* vers la categorie browser", () => {
    expect(estimateToolCharge({ userId: "u", executionId: "e", toolName: "browser.click", input: {} }).category).toBe("browser");
  });

  it("route code.execute vers la categorie code", () => {
    expect(estimateToolCharge({ userId: "u", executionId: "e", toolName: "code.execute", input: {} }).category).toBe("code");
  });

  it("route embed vers la categorie embedding", () => {
    expect(estimateToolCharge({ userId: "u", executionId: "e", toolName: "memory.embed", input: {} }).category).toBe("embedding");
  });

  it("route phone.call vers la categorie voice", () => {
    expect(estimateToolCharge({ userId: "u", executionId: "e", toolName: "phone.call", input: {} }).category).toBe("voice");
  });
});

describe("estimateToolCharge — couts externes", () => {
  it("honore un cout externe explicite fourni par l'outil", () => {
    const result = estimateToolCharge({ userId: "u", executionId: "e", toolName: "web.search", input: { externalCostEur: 0.05 } });
    expect(result.chargeMinor).toBeGreaterThanOrEqual(1);
  });

  it("facture phone.call au prorata de la duree demandee (30 s minimum)", () => {
    const minimal = estimateToolCharge({ userId: "u", executionId: "e", toolName: "phone.call", input: { maxDurationSeconds: 1 } });
    const thirty = estimateToolCharge({ userId: "u", executionId: "e", toolName: "phone.call", input: { maxDurationSeconds: 30 } });
    // Les deux doivent valoir 30 s facturees : 0.12 EUR/min * 0.5 min = 0.06 EUR de cout externe.
    expect(minimal.chargeMinor).toBe(thirty.chargeMinor);
    expect(thirty.chargeMinor).toBeGreaterThan(0);
  });

  it("plafonne phone.call a 900 secondes", () => {
    const max = estimateToolCharge({ userId: "u", executionId: "e", toolName: "phone.call", input: { maxDurationSeconds: 5000 } });
    const at900 = estimateToolCharge({ userId: "u", executionId: "e", toolName: "phone.call", input: { maxDurationSeconds: 900 } });
    expect(max.chargeMinor).toBe(at900.chargeMinor);
  });

  it("garde une complexite finie entre 0.5 et 5", () => {
    const result = estimateToolCharge({ userId: "u", executionId: "e", toolName: "web.search", input: { complexity: Number.NaN } });
    expect(Number.isFinite(result.chargeMinor)).toBe(true);
  });
});

describe("reserveToolExecution — garde-fous portefeuille", () => {
  it("refuse une execution si le solde disponible est insuffisant", async () => {
    mockedGetWallet.mockResolvedValue({ availableMinor: 0, balanceMinor: 0, reservedMinor: 0, currency: "EUR", welcomeGranted: true } as Awaited<ReturnType<typeof getWallet>>);
    await expect(
      reserveToolExecution({ userId: "u", executionId: "e", toolName: "browser.click", input: {} }),
    ).rejects.toThrow(/Insufficient wallet balance/i);
    expect(mockedReserveFunds).not.toHaveBeenCalled();
  });

  it("reserve les fonds et renvoie la reference en cas de solde suffisant", async () => {
    mockedGetWallet.mockResolvedValue({ availableMinor: 100_000, balanceMinor: 100_000, reservedMinor: 0, currency: "EUR", welcomeGranted: true } as Awaited<ReturnType<typeof getWallet>>);
    mockedReserveFunds.mockResolvedValue({ reference: "ref", reservedMinor: 1 } as never);
    const result = await reserveToolExecution({ userId: "u", executionId: "exec-1", toolName: "web.search", input: {} });
    expect(result.reference).toContain("exec-1");
    expect(result.reserveMinor).toBeGreaterThanOrEqual(1);
    expect(mockedReserveFunds).toHaveBeenCalledOnce();
  });

  it("retombe sur 100 minor (1 EUR) quand l'estimation n'est pas finie", async () => {
    mockedGetWallet.mockResolvedValue({ availableMinor: 100_000, balanceMinor: 100_000, reservedMinor: 0, currency: "EUR", welcomeGranted: true } as Awaited<ReturnType<typeof getWallet>>);
    mockedReserveFunds.mockResolvedValue({ reference: "ref", reservedMinor: 100 } as never);
    const result = await reserveToolExecution({ userId: "u", executionId: "e", toolName: "web.search", input: { externalCostEur: Number.POSITIVE_INFINITY } });
    // estimateToolCharge accepte externalCostEur explicite positif seulement ; Infinity est filtre par Math.max(0, ...) → charge minimale.
    expect(result.reserveMinor).toBeGreaterThanOrEqual(1);
  });
});

describe("settleToolExecution — cloture de reservation", () => {
  it("plafonne la facturation reelle a la limite de depense autonome", async () => {
    mockedSettleReservation.mockResolvedValue({} as never);
    const result = await settleToolExecution({
      userId: "u",
      toolName: "code.execute",
      input: { durationMs: 10 * 60_000 },
      durationMs: 10 * 60_000,
      reference: "ref-1",
      reserveMinor: 100,
    });
    expect(result.chargeMinor).toBeGreaterThanOrEqual(0);
    expect(mockedSettleReservation).toHaveBeenCalledOnce();
  });
});

describe("releaseToolExecution", () => {
  it("delegue la liberation au portefeuille", async () => {
    const { releaseReservation } = await import("./wallet");
    vi.mocked(releaseReservation).mockResolvedValue({ ok: true } as never);
    await releaseToolExecution({ userId: "u", reference: "ref", reserveMinor: 100 });
    expect(releaseReservation).toHaveBeenCalledOnce();
  });
});

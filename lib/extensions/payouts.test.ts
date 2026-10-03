import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Retraits développeurs (Task 80) : validation du montant et du mandat,
 * engagement transactionnel (jamais de sur-paiement), cycle de vie
 * requested → approved → paid / rejected (libération de l'engagement).
 */

const txDocs = new Map<string, { exists: boolean; data: () => Record<string, unknown> }>();
const txSet = vi.fn();
const txCreate = vi.fn();
const txUpdate = vi.fn();
const txObject = {
  get: vi.fn(async (ref: { __path: string }) => {
    const doc = txDocs.get(ref.__path);
    return {
      exists: Boolean(doc?.exists),
      // data stocké soit en objet soit en fabrique — les deux résolus en objet.
      data: () => (typeof doc?.data === "function" ? (doc.data as () => Record<string, unknown>)() : doc?.data ?? {}),
    };
  }),
  set: txSet,
  create: txCreate,
  update: txUpdate,
};

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    runTransaction: vi.fn(async (fn: (tx: typeof txObject) => Promise<unknown>) => fn(txObject)),
    collection: vi.fn((name: string) => ({
      doc: vi.fn((id?: string) => ({
        __path: `${name}/${id ?? "auto"}`,
        update: vi.fn(async (data: unknown) => ({ __path: `${name}/${id}`, data })),
        get: vi.fn(async () => ({ exists: false, data: () => ({}) })),
      })),
    })),
  },
}));

vi.mock("@/lib/billing/wallet", () => ({ WALLET_CURRENCY: "XAF" }));

const notificationMocks = vi.hoisted(() => ({ createNotification: vi.fn(async () => ({ id: "n1" })) }));
vi.mock("@/lib/notifications/repository", () => ({ createNotification: notificationMocks.createNotification }));

const repoMocks = vi.hoisted(() => {
  const payoutUpdate = vi.fn(async (data: Record<string, unknown>) => data);
  return {
    payoutUpdate,
    developerPayoutStatsRef: vi.fn((developerId: string) => ({ __path: `developerPayoutStats/${developerId}` })),
    getDeveloperPayoutStats: vi.fn(async () => null),
    getPayoutDoc: vi.fn(),
    listPayoutsByDeveloper: vi.fn(async () => []),
    listPayoutsByStatus: vi.fn(async () => []),
    payoutRef: vi.fn((payoutId: string) => ({
      __path: `developerPayouts/${payoutId}`,
      update: payoutUpdate,
      get: vi.fn(async () => ({ exists: false, data: () => ({}) })),
    })),
    sumDeveloperNetEarnings: vi.fn(async () => 0),
  };
});
vi.mock("./repository", () => repoMocks);

import {
  decideDeveloperPayout,
  getDeveloperPayoutBalance,
  payoutDecisionTransition,
  PayoutError,
  requestDeveloperPayout,
  sanitizePayoutMethodDetail,
  validatePayoutAmount,
} from "./payouts";

function payoutFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "payout_abc",
    developerId: "dev1",
    amountMinor: 800_000,
    currency: "XAF",
    method: "mtn_momo",
    methodDetail: { accountName: "John Doe", accountNumber: "+237600000000", bankName: null, country: "CM" },
    status: "requested",
    developerNote: null,
    adminNote: null,
    providerRef: null,
    requestedAt: Date.now(),
    decidedAt: null,
    paidAt: null,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("validatePayoutAmount", () => {
  it("refuse non-entier, négatif et sous le minimum", () => {
    expect(() => validatePayoutAmount(10.5)).toThrow(PayoutError);
    expect(() => validatePayoutAmount(-1)).toThrow(PayoutError);
    expect(() => validatePayoutAmount(1)).toThrow(/minimum/);
    expect(() => validatePayoutAmount("abc")).toThrow(PayoutError);
  });

  it("accepte un entier en unités mineures au-dessus du minimum", () => {
    expect(validatePayoutAmount(500_000)).toBe(500_000);
    expect(validatePayoutAmount(1_250_000)).toBe(1_250_000);
  });
});

describe("sanitizePayoutMethodDetail", () => {
  it("exige titulaire et compte, borne le pays à un code ISO", () => {
    expect(() => sanitizePayoutMethodDetail(null)).toThrow(PayoutError);
    expect(() => sanitizePayoutMethodDetail({ accountName: " ", accountNumber: "1", country: "CM" })).toThrow(/requis/);
    expect(() => sanitizePayoutMethodDetail({ accountName: "John", accountNumber: "1", country: "CMR" })).toThrow(/pays/i);
  });

  it("refuse les caractères de contrôle, normalise le pays", () => {
    expect(() => sanitizePayoutMethodDetail({ accountName: "John\u0000Doe", accountNumber: "1", country: "cm" })).toThrow(/contrôle/);
    const detail = sanitizePayoutMethodDetail({ accountName: "  John   Doe ", accountNumber: " +237 6 00 ", country: "cm" });
    expect(detail).toEqual({ accountName: "John Doe", accountNumber: "+237 6 00", bankName: null, country: "CM" });
  });
});

describe("payoutDecisionTransition", () => {
  it("table de transitions stricte", () => {
    expect(payoutDecisionTransition("requested", "approve")).toBe("approved");
    expect(payoutDecisionTransition("approved", "approve")).toBeNull();
    expect(payoutDecisionTransition("paid", "approve")).toBeNull();
    expect(payoutDecisionTransition("requested", "reject")).toBe("rejected");
    expect(payoutDecisionTransition("approved", "reject")).toBe("rejected");
    expect(payoutDecisionTransition("paid", "reject")).toBeNull();
    expect(payoutDecisionTransition("requested", "mark_paid")).toBeNull();
    expect(payoutDecisionTransition("approved", "mark_paid")).toBe("paid");
    expect(payoutDecisionTransition("rejected", "mark_paid")).toBeNull();
  });
});

describe("getDeveloperPayoutBalance", () => {
  it("disponible = gagné − engagé (stats présentes)", async () => {
    repoMocks.sumDeveloperNetEarnings.mockResolvedValue(1_000_000);
    repoMocks.getDeveloperPayoutStats.mockResolvedValueOnce({ committedMinor: 300_000, payoutCount: 1 });
    const balance = await getDeveloperPayoutBalance("dev1");
    expect(balance).toMatchObject({ earnedMinor: 1_000_000, committedMinor: 300_000, availableMinor: 700_000, currency: "XAF", payoutCount: 1 });
  });

  it("sans stats : engagé nul, minimum exposé", async () => {
    repoMocks.sumDeveloperNetEarnings.mockResolvedValue(0);
    const balance = await getDeveloperPayoutBalance("dev1");
    expect(balance).toMatchObject({ earnedMinor: 0, committedMinor: 0, availableMinor: 0, currency: "XAF" });
    expect(balance.minPayoutMinor).toBeGreaterThan(0);
  });
});

describe("requestDeveloperPayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txDocs.clear();
    repoMocks.sumDeveloperNetEarnings.mockResolvedValue(1_000_000);
  });

  it("solde suffisant : engagement transactionnel + mandat créé + notification", async () => {
    const payout = await requestDeveloperPayout({
      developerId: "dev1",
      amountMinor: 800_000,
      method: "mtn_momo",
      methodDetail: { accountName: "John Doe", accountNumber: "+237600000000", country: "CM" },
    });

    expect(payout.status).toBe("requested");
    expect(txSet).toHaveBeenCalledTimes(1);
    const [statsRef, statsData] = txSet.mock.calls[0];
    expect(statsRef.__path).toBe("developerPayoutStats/dev1");
    expect(statsData.committedMinor).toBe(800_000);
    expect(statsData.payoutCount).toBe(1);
    expect(txCreate).toHaveBeenCalledTimes(1);
    const [, payoutData] = txCreate.mock.calls[0];
    expect(payoutData.amountMinor).toBe(800_000);
    expect(payoutData.methodDetail.accountName).toBe("John Doe");
    expect(notificationMocks.createNotification).toHaveBeenCalledTimes(1);
  });

  it("stats existantes : engagement CUMULÉ sur le précédent", async () => {
    txDocs.set("developerPayoutStats/dev1", { exists: true, data: () => ({ committedMinor: 100_000, payoutCount: 1 }) });
    await requestDeveloperPayout({
      developerId: "dev1",
      amountMinor: 500_000,
      method: "orange_money",
      methodDetail: { accountName: "John Doe", accountNumber: "0700", country: "CI" },
    });
    const [, statsData] = txSet.mock.calls[0];
    expect(statsData.committedMinor).toBe(600_000);
    expect(statsData.payoutCount).toBe(2);
  });

  it("solde insuffisant : PayoutError, AUCUN engagement ni mandat", async () => {
    await expect(
      requestDeveloperPayout({
        developerId: "dev1",
        amountMinor: 5_000_000,
        method: "mtn_momo",
        methodDetail: { accountName: "John Doe", accountNumber: "1", country: "CM" },
      }),
    ).rejects.toThrow(/Solde insuffisant/);
    expect(txSet).not.toHaveBeenCalled();
    expect(txCreate).not.toHaveBeenCalled();
    expect(notificationMocks.createNotification).not.toHaveBeenCalled();
  });

  it("méthode invalide refusée", async () => {
    await expect(
      requestDeveloperPayout({
        developerId: "dev1",
        amountMinor: 800_000,
        method: "paypal",
        methodDetail: { accountName: "John Doe", accountNumber: "1", country: "CM" },
      }),
    ).rejects.toThrow(/Moyen de paiement invalide/);
  });
});

describe("decideDeveloperPayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txDocs.clear();
  });

  it("approve : requested → approved", async () => {
    repoMocks.getPayoutDoc.mockResolvedValueOnce(payoutFixture());
    repoMocks.getPayoutDoc.mockResolvedValueOnce(payoutFixture({ status: "approved" }));
    const result = await decideDeveloperPayout({ payoutId: "payout_abc", decision: "approve", adminNote: "OK" });
    expect(result.status).toBe("approved");
    expect(repoMocks.payoutUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: "approved", adminNote: "OK" }));
    expect(notificationMocks.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: "Retrait approuvé" }));
  });

  it("mark_paid exige une référence fournisseur", async () => {
    repoMocks.getPayoutDoc.mockResolvedValueOnce(payoutFixture({ status: "approved" }));
    await expect(decideDeveloperPayout({ payoutId: "payout_abc", decision: "mark_paid" })).rejects.toThrow(/référence fournisseur/);
  });

  it("mark_paid : paid + providerRef + horodatage", async () => {
    repoMocks.getPayoutDoc.mockResolvedValueOnce(payoutFixture({ status: "approved" }));
    repoMocks.getPayoutDoc.mockResolvedValueOnce(payoutFixture({ status: "paid", providerRef: "MM123456" }));
    const result = await decideDeveloperPayout({ payoutId: "payout_abc", decision: "mark_paid", providerRef: "MM123456" });
    expect(result.status).toBe("paid");
    expect(result.providerRef).toBe("MM123456");
    expect(repoMocks.payoutUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: "paid", providerRef: "MM123456", decidedAt: expect.any(Number), paidAt: expect.any(Number) }));
    expect(notificationMocks.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: "Retrait payé" }));
  });

  it("reject : engagement LIBÉRÉ dans la même transaction que le statut", async () => {
    txDocs.set("developerPayoutStats/dev1", { exists: true, data: () => ({ committedMinor: 800_000, payoutCount: 1 }) });
    repoMocks.getPayoutDoc.mockResolvedValueOnce(payoutFixture({ status: "approved" }));
    repoMocks.getPayoutDoc.mockResolvedValueOnce(payoutFixture({ status: "rejected" }));

    const result = await decideDeveloperPayout({ payoutId: "payout_abc", decision: "reject", adminNote: "compte non vérifié" });

    expect(result.status).toBe("rejected");
    expect(txSet).toHaveBeenCalledTimes(1);
    const [, statsData] = txSet.mock.calls[0];
    expect(statsData.committedMinor).toBe(0);
    expect(txUpdate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "rejected", adminNote: "compte non vérifié" }));
    expect(notificationMocks.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: "Retrait rejeté" }));
  });

  it("transition interdite : approve sur un mandat déjà payé", async () => {
    repoMocks.getPayoutDoc.mockResolvedValueOnce(payoutFixture({ status: "paid" }));
    await expect(decideDeveloperPayout({ payoutId: "payout_abc", decision: "approve" })).rejects.toThrow(/Transition impossible/);
  });

  it("mandat inconnu : 404", async () => {
    repoMocks.getPayoutDoc.mockResolvedValueOnce(null);
    await expect(decideDeveloperPayout({ payoutId: "nope", decision: "approve" })).rejects.toThrow(/introuvable/);
  });
});

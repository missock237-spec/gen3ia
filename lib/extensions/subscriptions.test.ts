import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Renouvellement auto des abonnements d'extensions (Task 80) :
 * due dans la fenêtre d'avance, débit wallet idempotent par période, achat
 * d'audit à ID déterministe, grâce 7 jours puis expiration, convergence
 * sans double débit ni double comptage de revenu.
 */

const entitlementUpdates = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn((name: string) => ({
      doc: vi.fn((id: string) => ({
        __path: `${name}/${id}`,
        update: entitlementUpdates,
        get: vi.fn(async () => ({ exists: false, data: () => ({}) })),
      })),
    })),
    runTransaction: vi.fn(),
  },
}));

const walletMocks = vi.hoisted(() => ({
  reserveFunds: vi.fn(),
  settleReservation: vi.fn(),
}));
vi.mock("@/lib/billing/wallet", () => ({
  reserveFunds: walletMocks.reserveFunds,
  settleReservation: walletMocks.settleReservation,
  WALLET_CURRENCY: "XAF",
}));

const notificationMocks = vi.hoisted(() => ({ createNotification: vi.fn(async () => ({ id: "n1" })) }));
vi.mock("@/lib/notifications/repository", () => ({
  createNotification: notificationMocks.createNotification,
}));

const repoMocks = vi.hoisted(() => ({
  addDeveloperRevenue: vi.fn(async () => ({})),
  createExtensionPurchase: vi.fn(async (input: { id?: string }) => ({ id: input.id ?? "auto", status: "pending" })),
  createLicense: vi.fn(async () => ({})),
  getExtension: vi.fn(),
  getExtensionPurchase: vi.fn(async () => null),
  listSubscriptionEntitlements: vi.fn(async () => []),
  markPurchasePaid: vi.fn(async () => ({ status: "paid" })),
}));
vi.mock("./repository", () => repoMocks);

import {
  isRenewalDue,
  overdueState,
  renewalPurchaseId,
  renewalWalletReference,
  renewDueExtensionSubscriptions,
  shouldSendRenewalAlert,
  RENEWAL_LEAD_MS,
  SUBSCRIPTION_GRACE_MS,
} from "./subscriptions";

const DAY = 24 * 60 * 60 * 1000;

function entitlement(overrides: Record<string, unknown>) {
  return {
    id: "ext1__user1",
    extensionId: "ext1",
    userId: "user1",
    status: "active",
    source: "subscription",
    purchaseId: "p1",
    expiresAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Parameters<typeof isRenewalDue>[0];
}

const APPROVED_EXTENSION = {
  id: "ext1",
  name: "Assistant Pro",
  developerId: "dev1",
  deletedAt: null,
  pricing: { model: "subscription", amountMinor: 500_000, interval: "month", currency: "XAF" },
};

describe("déterminisme des références de renouvellement", () => {
  it("dérive un ID d'achat et une référence wallet stables par période", () => {
    expect(renewalPurchaseId("ext1__user1", 1_000)).toBe("renewal-ext1__user1-1000");
    expect(renewalPurchaseId("ext1__user1", 1_000)).toBe(renewalPurchaseId("ext1__user1", 1_000));
    expect(renewalWalletReference("ext1__user1", 1_000)).toBe("ext-renewal-ext1__user1-1000");
    expect(renewalPurchaseId("ext1__user1", 2_000)).not.toBe(renewalPurchaseId("ext1__user1", 1_000));
  });
});

describe("isRenewalDue", () => {
  const now = 10 * DAY;

  it("ignore les non-abonnements actifs, désactivés ou sans terme", () => {
    expect(isRenewalDue(entitlement({ status: "expired" }), now)).toBe(false);
    expect(isRenewalDue(entitlement({ autoRenew: false }), now)).toBe(false);
    expect(isRenewalDue(entitlement({ expiresAt: null }), now)).toBe(false);
  });

  it("échéance dans la fenêtre d'avance (36 h) → dû", () => {
    expect(isRenewalDue(entitlement({ expiresAt: now + RENEWAL_LEAD_MS - 1 }), now)).toBe(true);
    expect(isRenewalDue(entitlement({ expiresAt: now + RENEWAL_LEAD_MS + 1 }), now)).toBe(false);
    expect(isRenewalDue(entitlement({ expiresAt: now - 3 * DAY }), now)).toBe(true);
  });
});

describe("overdueState / shouldSendRenewalAlert", () => {
  it("grâce sous 7 jours, expiration au-delà", () => {
    expect(overdueState(0)).toBe("grace");
    expect(overdueState(SUBSCRIPTION_GRACE_MS - 1)).toBe("grace");
    expect(overdueState(SUBSCRIPTION_GRACE_MS)).toBe("expired");
  });

  it("alertes espacées de 48 h, première toujours envoyée", () => {
    expect(shouldSendRenewalAlert(null, 1000)).toBe(true);
    expect(shouldSendRenewalAlert(1000, 1000 + DAY)).toBe(false);
    expect(shouldSendRenewalAlert(1000, 1000 + 2 * DAY)).toBe(true);
  });
});

describe("passage de renouvellement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    entitlementUpdates.mockResolvedValue(undefined);
    walletMocks.reserveFunds.mockResolvedValue({});
    walletMocks.settleReservation.mockResolvedValue({});
    repoMocks.listSubscriptionEntitlements.mockResolvedValue([]);
    repoMocks.getExtension.mockResolvedValue(APPROVED_EXTENSION);
    repoMocks.getExtensionPurchase.mockResolvedValue(null);
    repoMocks.getExtensionPurchase.mockImplementation(async () => null);
  });

  it("abonnement non dû : rien ne se passe", async () => {
    repoMocks.listSubscriptionEntitlements.mockResolvedValue([
      entitlement({ expiresAt: Date.now() + 30 * DAY }) as never,
    ]);
    const report = await renewDueExtensionSubscriptions(new Date());
    expect(report.processed).toBe(0);
    expect(walletMocks.reserveFunds).not.toHaveBeenCalled();
  });

  it("abonnement dû + wallet financé : débit, achat déterministe, revenu, prolongation, licence, notification", async () => {
    const now = new Date("2026-10-04T06:00:00Z");
    const nowMs = now.getTime();
    const currentExpiry = nowMs + 12 * 60 * 60 * 1000; // dans la fenêtre d'avance
    repoMocks.listSubscriptionEntitlements.mockResolvedValue([
      entitlement({ expiresAt: currentExpiry }) as never,
    ]);

    const report = await renewDueExtensionSubscriptions(now);

    expect(report.charged).toBe(1);
    expect(walletMocks.reserveFunds).toHaveBeenCalledTimes(1);
    const reserveArgs = walletMocks.reserveFunds.mock.calls[0][0];
    expect(reserveArgs.reference).toBe(`ext-renewal-ext1__user1-${currentExpiry}`);
    expect(reserveArgs.amountMinor).toBe(500_000);
    expect(walletMocks.settleReservation).toHaveBeenCalledTimes(1);
    expect(repoMocks.createExtensionPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `renewal-ext1__user1-${currentExpiry}`,
        provider: "wallet",
        kind: "subscription",
        amountMinor: 500_000,
      }),
    );
    expect(repoMocks.markPurchasePaid).toHaveBeenCalledWith(`renewal-ext1__user1-${currentExpiry}`, `wallet:ext-renewal-ext1__user1-${currentExpiry}`);
    expect(repoMocks.addDeveloperRevenue).toHaveBeenCalledWith(
      expect.objectContaining({ developerId: "dev1", purchaseId: `renewal-ext1__user1-${currentExpiry}`, grossAmountMinor: 500_000 }),
    );
    expect(repoMocks.createLicense).toHaveBeenCalledTimes(1);
    expect(notificationMocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user1", type: "info", title: "Abonnement renouvelé" }),
    );
    // Prolongation d'un mois complet depuis le TERME courant (pas de chevauchement).
    expect(entitlementUpdates).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active", renewalState: "ok", renewalNotice: null }),
    );
  });

  it("wallet insuffisant dans la grâce : échec marqué + alerte, aucun achat", async () => {
    const nowMs = Date.now();
    const currentExpiry = nowMs - 2 * DAY; // en retard de 2 jours → grâce
    repoMocks.listSubscriptionEntitlements.mockResolvedValue([
      entitlement({ expiresAt: currentExpiry }) as never,
    ]);
    walletMocks.reserveFunds.mockRejectedValue(new Error("Insufficient wallet balance for this execution."));

    const report = await renewDueExtensionSubscriptions(new Date(nowMs));

    expect(report.grace).toBe(1);
    expect(repoMocks.createExtensionPurchase).not.toHaveBeenCalled();
    expect(repoMocks.addDeveloperRevenue).not.toHaveBeenCalled();
    expect(entitlementUpdates).toHaveBeenCalledTimes(1);
    const updateArg = entitlementUpdates.mock.calls[0][0] as Record<string, unknown>;
    expect(updateArg.renewalState).toBe("failed");
    // En grâce, le statut de l'entitlement n'est PAS touché (l'usage est
    // déjà bloqué par l'expiration passée).
    expect(updateArg).not.toHaveProperty("status");
    expect(notificationMocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Renouvellement en attente" }),
    );
  });

  it("impayé au-delà de la grâce : expiration définitive + autoRenew coupé", async () => {
    const nowMs = Date.now();
    const currentExpiry = nowMs - SUBSCRIPTION_GRACE_MS - 1;
    repoMocks.listSubscriptionEntitlements.mockResolvedValue([
      entitlement({ expiresAt: currentExpiry, renewalAlertCount: 2 }) as never,
    ]);
    walletMocks.reserveFunds.mockRejectedValue(new Error("Insufficient wallet balance for this execution."));

    const report = await renewDueExtensionSubscriptions(new Date(nowMs));

    expect(report.expired).toBe(1);
    expect(entitlementUpdates).toHaveBeenCalledWith(
      expect.objectContaining({ status: "expired", autoRenew: false, renewalState: "failed" }),
    );
    // L'expiration finale est TOUJOURS annoncée.
    expect(notificationMocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Abonnement expiré" }),
    );
  });

  it("convergence : achat de période déjà payé → ni débit ni revenu, mais prolongation", async () => {
    const nowMs = Date.now();
    const currentExpiry = nowMs + DAY;
    repoMocks.listSubscriptionEntitlements.mockResolvedValue([
      entitlement({ expiresAt: currentExpiry }) as never,
    ]);
    repoMocks.getExtensionPurchase.mockResolvedValue({
      id: `renewal-ext1__user1-${currentExpiry}`,
      status: "paid",
      amountMinor: 500_000,
    });

    const report = await renewDueExtensionSubscriptions(new Date(nowMs));

    expect(report.charged).toBe(1);
    expect(walletMocks.reserveFunds).not.toHaveBeenCalled();
    expect(repoMocks.addDeveloperRevenue).not.toHaveBeenCalled();
    expect(repoMocks.createLicense).toHaveBeenCalledTimes(1);
  });

  it("autoRenew désactivé : jamais débité", async () => {
    repoMocks.listSubscriptionEntitlements.mockResolvedValue([
      entitlement({ expiresAt: Date.now() - DAY, autoRenew: false }) as never,
    ]);
    const report = await renewDueExtensionSubscriptions(new Date());
    expect(report.processed).toBe(0);
    expect(walletMocks.reserveFunds).not.toHaveBeenCalled();
  });

  it("extension supprimée : ignorée sans débit", async () => {
    repoMocks.listSubscriptionEntitlements.mockResolvedValue([
      entitlement({ expiresAt: Date.now() - DAY }) as never,
    ]);
    repoMocks.getExtension.mockResolvedValue(null);
    const report = await renewDueExtensionSubscriptions(new Date());
    expect(report.skipped).toBe(1);
    expect(walletMocks.reserveFunds).not.toHaveBeenCalled();
  });
});

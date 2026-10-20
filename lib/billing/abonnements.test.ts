import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Abonnements aux offres Gen3ia : activation idempotente par référence de
 * vente (journal planActivations), empilement des fenêtres d'accès lors des
 * renouvellements anticipés, expiration avec période de grâce, gating des
 * fonctionnalités (requirePlanEntitlement / hasPlanEntitlement).
 */

const planDoc = { get: vi.fn(), set: vi.fn() };
const activationDoc = { get: vi.fn(), create: vi.fn() };
const runTransaction = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn((name: string) => ({
      doc: vi.fn(() => (name === "userPlans" ? planDoc : activationDoc)),
    })),
    runTransaction: (...args: unknown[]) => runTransaction(...args),
  },
}));

import { activatePlanFromLicense, activatePlanFromSale, GRACE_PERIOD_DAYS } from "./abonnements";

function inTransaction() {
  runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      get: (ref: { get: () => Promise<unknown> }) => ref.get(),
      create: (_ref: unknown, data: unknown) => activationDoc.create(data),
      set: (_ref: unknown, data: unknown) => planDoc.set(data),
    }),
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function freshDocs() {
  planDoc.get.mockResolvedValue({ exists: false, data: () => ({}) });
  activationDoc.get.mockResolvedValue({ exists: false, data: () => ({}) });
}

describe("activatePlanFromSale (webhook Pulse plan_subscription)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inTransaction();
    freshDocs();
  });

  it("active un plan Pro pour 30 jours à partir d'une vente Chariow", async () => {
    const before = Date.now();
    const result = await activatePlanFromSale({ userId: "user-1", planId: "pro", saleId: "sal_abc", source: "checkout" });

    expect(result.kind).toBe("activated");
    if (result.kind !== "activated") return;
    expect(result.state.planId).toBe("pro");
    expect(result.state.active).toBe(true);
    expect(result.state.source).toBe("checkout");
    expect(result.state.lastSaleId).toBe("sal_abc");
    expect(result.state.expiresAt).not.toBeNull();
    expect(result.state.expiresAt! - before).toBeGreaterThan(29 * DAY_MS);
    expect(result.state.expiresAt! - before).toBeLessThan(31 * DAY_MS);
    expect(activationDoc.create).toHaveBeenCalledTimes(1);
    expect(planDoc.set).toHaveBeenCalledTimes(1);
  });

  it("est idempotent : la même vente re-délivrée ne prolonge pas l'accès", async () => {
    await activatePlanFromSale({ userId: "user-1", planId: "pro", saleId: "sal_abc", source: "checkout" });
    const firstExpiry = planDoc.set.mock.calls[0][0].expiresAt as number;

    // Reprise : le journal planActivations/${plan_sal_abc} existe désormais.
    activationDoc.get.mockResolvedValue({ exists: true, data: () => ({ userId: "user-1", planId: "pro" }) });
    planDoc.get.mockResolvedValue({
      exists: true,
      data: () => ({ planId: "pro", expiresAt: firstExpiry, activatedAt: Date.now(), source: "checkout", lastSaleId: "sal_abc" }),
    });

    const second = await activatePlanFromSale({ userId: "user-1", planId: "pro", saleId: "sal_abc", source: "checkout" });
    expect(second.kind).toBe("duplicate");
    if (second.kind !== "duplicate") return;
    expect(second.state.expiresAt).toBe(firstExpiry);
    expect(activationDoc.create).toHaveBeenCalledTimes(1);
  });

  it("empile la fenêtre d'un renouvellement anticipé sur la fin de la fenêtre courante", async () => {
    const currentExpiry = Date.now() + 10 * DAY_MS;
    await activatePlanFromSale({ userId: "user-1", planId: "entreprise", saleId: "sal_ent", source: "checkout" });

    planDoc.get.mockResolvedValue({
      exists: true,
      data: () => ({ planId: "entreprise", expiresAt: currentExpiry, activatedAt: Date.now(), source: "checkout" }),
    });
    activationDoc.get.mockResolvedValue({ exists: false, data: () => ({}) });

    const renewal = await activatePlanFromSale({ userId: "user-1", planId: "entreprise", saleId: "sal_ent2", source: "checkout" });
    expect(renewal.kind).toBe("activated");
    if (renewal.kind !== "activated") return;
    expect(renewal.state.expiresAt! - currentExpiry).toBeGreaterThan(29 * DAY_MS);
    expect(renewal.state.expiresAt! - currentExpiry).toBeLessThan(31 * DAY_MS);
  });

  it("repart de la date courante quand l'abonnement précédent a expiré", async () => {
    await activatePlanFromSale({ userId: "user-1", planId: "pro", saleId: "sal_old", source: "checkout" });

    planDoc.get.mockResolvedValue({
      exists: true,
      data: () => ({ planId: "pro", expiresAt: Date.now() - 5 * DAY_MS, activatedAt: Date.now() - 35 * DAY_MS, source: "checkout" }),
    });
    activationDoc.get.mockResolvedValue({ exists: false, data: () => ({}) });

    const before = Date.now();
    const renewed = await activatePlanFromSale({ userId: "user-1", planId: "pro", saleId: "sal_new", source: "checkout" });
    expect(renewed.kind).toBe("activated");
    if (renewed.kind !== "activated") return;
    expect(renewed.state.expiresAt! - before).toBeGreaterThan(29 * DAY_MS);
  });

  it("accorde le plan sur-mesure sans expiration (achat unitaire)", async () => {
    const result = await activatePlanFromSale({ userId: "user-9", planId: "modele-sur-mesure", saleId: "sal_msm", source: "checkout" });
    expect(result.kind).toBe("activated");
    if (result.kind !== "activated") return;
    expect(result.state.expiresAt).toBeNull();
  });

  it("ignore un identifiant de plan inconnu (pas d'écriture)", async () => {
    const result = await activatePlanFromSale({ userId: "user-1", planId: "diamond", saleId: "sal_x", source: "checkout" });
    expect(result.kind).toBe("ignored");
    expect(planDoc.set).not.toHaveBeenCalled();
  });
});

describe("activatePlanFromLicense (clé de licence Chariow)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inTransaction();
    freshDocs();
  });

  it("active l'accès avec une référence d'idempotence dédiée à la licence", async () => {
    const result = await activatePlanFromLicense({ userId: "user-2", planId: "pro", licenseKey: "GEN3IA-PRO-0001" });
    expect(result.kind).toBe("activated");
    if (result.kind !== "activated") return;
    expect(result.state.source).toBe("licence");
    expect(result.state.lastLicenseKey).toBe("GEN3IA-PRO-0001");
    expect(result.state.expiresAt).not.toBeNull();
    // La référence de journal doit être licence_${clé}, pas plan_${vente}.
    expect(activationDoc.create).toHaveBeenCalledWith(expect.objectContaining({ reference: "licence_GEN3IA-PRO-0001" }));
  });
});

describe("période de grâce", () => {
  it("est de 3 jours calendaires", () => {
    expect(GRACE_PERIOD_DAYS).toBe(3);
  });
});

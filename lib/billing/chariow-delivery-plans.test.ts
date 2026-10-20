import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Traitement webhook des ventes d'abonnement (grille tarifaire Chariow) :
 * gen3ia_product = plan_subscription → activation du plan pour l'utilisateur
 * tagué au checkout (ou retrouvé par e-mail client), idempotence par vente,
 * ventes non pertinentes ignorées comme avant.
 */

const deliveryDoc = { get: vi.fn(), create: vi.fn(), update: vi.fn() };
const dedupGet = vi.fn();
const runTransaction = vi.fn();
const getUserByEmail = vi.fn();
const applyTopupMock = vi.fn();
const settleExtensionMock = vi.fn();
const activatePlanFromSaleMock = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => deliveryDoc),
      where: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(() => ({ get: dedupGet })) })),
      })),
    })),
    runTransaction: (...args: unknown[]) => runTransaction(...args),
  },
}));
vi.mock("firebase-admin/app", () => ({ getApps: vi.fn(() => [{}]) }));
vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(() => ({ getUserByEmail: (...args: unknown[]) => getUserByEmail(...args) })),
}));
vi.mock("./wallet", () => ({
  applyTopup: (...args: unknown[]) => applyTopupMock(...args),
  WALLET_CURRENCY: "XAF",
}));
vi.mock("@/lib/extensions/entitlements", () => ({
  settleChariowExtensionPurchase: (...args: unknown[]) => settleExtensionMock(...args),
}));
vi.mock("./abonnements", () => ({
  activatePlanFromSale: (...args: unknown[]) => activatePlanFromSaleMock(...args),
}));

import { processChariowSale } from "./chariow-delivery";

function planPayload(overrides: Record<string, unknown> = {}) {
  return {
    event: "successful.sale",
    customer: { email: "client@example.com" },
    product: { id: "prd_svqonju7" },
    sale: {
      id: "sal_plan_1",
      status: "completed",
      amount: { value: 9750, currency: "XAF" },
      custom_metadata: {
        gen3ia_product: "plan_subscription",
        plan_id: "pro",
        user_id: "user-gen3ia",
      },
      ...overrides,
    },
  };
}

describe("processChariowSale (plan_subscription)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runTransaction.mockReset();
    dedupGet.mockReset().mockResolvedValue({ docs: [] });
    deliveryDoc.update.mockReset().mockResolvedValue(undefined);
    deliveryDoc.create.mockReset();
    activatePlanFromSaleMock.mockResolvedValue({
      kind: "activated",
      state: { userId: "user-gen3ia", planId: "pro", active: true, source: "checkout", activatedAt: Date.now(), expiresAt: Date.now() + 30 * 86400000, lastSaleId: "sal_plan_1", lastLicenseKey: null },
    });
  });

  it("active le plan tagué dans les métadonnées (user_id du checkout)", async () => {
    const result = await processChariowSale(planPayload(), "delivery-1");

    expect(result).toEqual({
      kind: "plan_subscription",
      planId: "pro",
      userId: "user-gen3ia",
      activated: true,
    });
    expect(activatePlanFromSaleMock).toHaveBeenCalledWith(
      { userId: "user-gen3ia", planId: "pro", saleId: "sal_plan_1", source: "checkout" },
    );
    expect(deliveryDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processed", kind: "plan_subscription", planId: "pro" }),
    );
    // Pas de crédit wallet ni d'achat d'extension pour un abonnement.
    expect(applyTopupMock).not.toHaveBeenCalled();
    expect(settleExtensionMock).not.toHaveBeenCalled();
  });

  it("retrouve l'utilisateur par l'e-mail client quand user_id est absent (achat storefront)", async () => {
    getUserByEmail.mockResolvedValue({ uid: "user-from-email" });
    const payload = planPayload({
      custom_metadata: { gen3ia_product: "plan_subscription", plan_id: "entreprise" },
    });

    const result = await processChariowSale(payload, "delivery-2");
    expect(result).toMatchObject({ kind: "plan_subscription", planId: "entreprise", userId: "user-from-email" });
    expect(getUserByEmail).toHaveBeenCalledWith("client@example.com");
  });

  it("marque l'échec quand l'e-mail ne correspond à aucun compte (reprise possible)", async () => {
    getUserByEmail.mockRejectedValue(new Error("no user"));
    const payload = planPayload({
      custom_metadata: { gen3ia_product: "plan_subscription", plan_id: "pro" },
    });

    const result = await processChariowSale(payload, "delivery-3");
    expect(result).toEqual({ kind: "user_not_found" });
    expect(deliveryDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", reason: "firebase_user_not_found" }),
    );
  });

  it("refuse une vente dont le statut n'est pas créditable", async () => {
    const result = await processChariowSale(planPayload({ status: "pending" }), "delivery-4");
    expect(result.kind).toBe("failed");
    expect(activatePlanFromSaleMock).not.toHaveBeenCalled();
  });

  it("refuse une vente plan_subscription sans référence de vente (soldId absent)", async () => {
    const result = await processChariowSale(planPayload({ id: "" }), "delivery-5");
    expect(result.kind).toBe("failed");
  });

  it("ignore toujours une vente sans métadonnées Gen3ia connues", async () => {
    const payload = {
      event: "successful.sale",
      customer: { email: "x@y.com" },
      product: { id: "prd_autre" },
      sale: { id: "sal_z", status: "completed", amount: { value: 100, currency: "XAF" }, custom_metadata: {} },
    };
    const result = await processChariowSale(payload, "delivery-6");
    expect(result.kind).toBe("ignored");
    expect(activatePlanFromSaleMock).not.toHaveBeenCalled();
  });

  it("propage un plan inconnu en échec métier (document reprendre)", async () => {
    activatePlanFromSaleMock.mockResolvedValue({ kind: "ignored", reason: "unknown_plan" });
    const payload = planPayload({
      custom_metadata: { gen3ia_product: "plan_subscription", plan_id: "diamond", user_id: "user-gen3ia" },
    });
    const result = await processChariowSale(payload, "delivery-7");
    expect(result.kind).toBe("failed");
    expect(deliveryDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error: expect.stringContaining("Unknown plan id") }),
    );
  });
});

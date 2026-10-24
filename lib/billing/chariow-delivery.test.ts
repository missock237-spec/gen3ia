import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "@/lib/r2fs";

/**
 * Livraison Chariow résiliente (Task 104-b) : claim transactionnel (premier
 * passage / reprise d'un échec / reprise d'un bail expiré / doublon /
 * in-flight), traitement métier déplacé du webhook (topup + achat
 * d'extension), dédoublonnement par saleId, snapshot de charge utile borné.
 * La reprise reste garantie financièrement par l'idempotence du wallet
 * (chariow_${saleId}) — hors périmètre ici, simulée par applyTopup.
 */

const deliveryDoc = { get: vi.fn(), create: vi.fn(), update: vi.fn() };
const dedupGet = vi.fn();
const runTransaction = vi.fn();
const getUserByEmail = vi.fn();
const applyTopupMock = vi.fn();
const settleExtensionMock = vi.fn();
const grantLicenceMock = vi.fn();

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
// Licences d'espace : le RÉSOLVEUR reste réel (reconnaissance produit + surcharges
// env testées en bout en bout) — seule l'écriture Firestore de l'accord est mockée
// (elle possède son propre fichier de tests : lib/storage/licences.test.ts).
vi.mock("@/lib/storage/licences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage/licences")>();
  return {
    ...actual,
    grantStorageLicence: (...args: unknown[]) => grantLicenceMock(...args),
  };
});

import {
  buildChariowPayloadSnapshot,
  CHARIOW_LEASE_MS,
  claimChariowDelivery,
  processChariowSale,
  receivedAtToMillis,
  storedChariowPayload,
} from "./chariow-delivery";

function inTransaction() {
  runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      get: (ref: { get: () => Promise<unknown> }) => ref.get(),
      create: (_ref: unknown, data: unknown) => deliveryDoc.create(data),
      update: (_ref: unknown, data: unknown) => deliveryDoc.update(data),
    }),
  );
}

const TOPUP_PAYLOAD = {
  event: "successful.sale",
  customer: { email: "Client@Example.com" },
  product: { id: "prod_topup" },
  sale: {
    id: "sale-1",
    status: "completed",
    amount: { value: 3000, currency: "XAF" },
    custom_metadata: { gen3ia_product: "wallet_topup" },
  },
};

const WALLET = {
  userId: "user-1",
  currency: "XAF",
  balanceMinor: 303_000,
  reservedMinor: 0,
  availableMinor: 303_000,
  updatedAt: 1,
  welcomeGranted: true,
  welcomeAmountMinor: 0,
};

beforeEach(() => {
  deliveryDoc.get.mockReset();
  deliveryDoc.create.mockReset();
  deliveryDoc.update.mockReset();
  // Firestore renvoie une promesse sur create/update (le chemin d'échec du
  // traitement chaîne un .catch dessus).
  deliveryDoc.create.mockResolvedValue(undefined);
  deliveryDoc.update.mockResolvedValue(undefined);
  dedupGet.mockReset();
  runTransaction.mockReset();
  getUserByEmail.mockReset();
  applyTopupMock.mockReset();
  settleExtensionMock.mockReset();
  grantLicenceMock.mockReset();
  delete process.env.CHARIOW_TOPUP_PRODUCT_ID;
  delete process.env.CHARIOW_ESPACE_100_PRODUCT_ID;
  delete process.env.CHARIOW_ESPACE_600_PRODUCT_ID;
});

describe("claimChariowDelivery (transaction)", () => {
  it("premier passage → create « processing » avec payload stocké (retraitable)", async () => {
    deliveryDoc.get.mockResolvedValue({ exists: false });
    inTransaction();
    const snapshot = buildChariowPayloadSnapshot({ event: "successful.sale", sale: { id: "sale-1" } });
    const claim = await claimChariowDelivery("d1", snapshot);
    expect(claim.action).toBe("process");
    expect(deliveryDoc.create).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "d1",
        status: "processing",
        attempts: 1,
        event: "successful.sale",
        payload: { event: "successful.sale", sale: { id: "sale-1" } },
      }),
    );
    expect(deliveryDoc.update).not.toHaveBeenCalled();
  });

  it("status processed/ignored → doublon pur, aucune écriture", async () => {
    inTransaction();
    for (const status of ["processed", "ignored"]) {
      deliveryDoc.get.mockResolvedValue({ exists: true, data: () => ({ status }) });
      const claim = await claimChariowDelivery("d1", {});
      expect(claim.action).toBe("duplicate-processed");
    }
    expect(deliveryDoc.create).not.toHaveBeenCalled();
    expect(deliveryDoc.update).not.toHaveBeenCalled();
  });

  it("status failed → REPRISE (attempts+1, reclaimedAt, payload rafraîchi)", async () => {
    deliveryDoc.get.mockResolvedValue({
      exists: true,
      data: () => ({ status: "failed", attempts: 1, receivedAt: new Date(Date.now() - 5_000) }),
    });
    inTransaction();
    const claim = await claimChariowDelivery("d2", { sale: { id: "sale-2" } });
    expect(claim.action).toBe("process");
    expect(deliveryDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processing", attempts: 2, payload: { sale: { id: "sale-2" } } }),
    );
    expect(deliveryDoc.update.mock.calls[0][0].reclaimedAt).toBeInstanceOf(Date);
  });

  it("bail « processing » expiré → REPRISE (fonction serveur tuée)", async () => {
    deliveryDoc.get.mockResolvedValue({
      exists: true,
      data: () => ({
        status: "processing",
        attempts: 1,
        receivedAt: new Date(Date.now() - CHARIOW_LEASE_MS - 1_000),
      }),
    });
    inTransaction();
    const claim = await claimChariowDelivery("d3", { sale: { id: "sale-3" } });
    expect(claim.action).toBe("process");
    expect(deliveryDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processing", attempts: 2 }),
    );
  });

  it("bail frais → in-flight, aucune écriture (un autre worker est dessus)", async () => {
    deliveryDoc.get.mockResolvedValue({
      exists: true,
      data: () => ({ status: "processing", attempts: 1, receivedAt: new Date() }),
    });
    inTransaction();
    const claim = await claimChariowDelivery("d4", {});
    expect(claim.action).toBe("in-flight");
    expect(deliveryDoc.create).not.toHaveBeenCalled();
    expect(deliveryDoc.update).not.toHaveBeenCalled();
  });

  it("garde : CHARIOW_LEASE_MS exporté et fixé à 10 minutes", () => {
    expect(CHARIOW_LEASE_MS).toBe(10 * 60 * 1000);
  });
});

describe("processChariowSale (topup wallet)", () => {
  it("vente créditable → applyTopup + document processed", async () => {
    dedupGet.mockResolvedValue({ docs: [] });
    getUserByEmail.mockResolvedValue({ uid: "user-1" });
    applyTopupMock.mockResolvedValue(WALLET);
    const result = await processChariowSale(TOPUP_PAYLOAD, "d1");
    expect(result).toEqual({ kind: "credited", wallet: WALLET });
    expect(applyTopupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        amountMinor: 300_000,
        currency: "XAF",
        providerReference: "sale-1",
      }),
    );
    expect(deliveryDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processed", userId: "user-1", saleId: "sale-1", amountMinor: 300_000 }),
    );
  });

  it("REPRISE après échec : le passage suivant retraite et crédite", async () => {
    dedupGet.mockResolvedValue({ docs: [] });
    getUserByEmail.mockResolvedValue({ uid: "user-1" });
    applyTopupMock.mockRejectedValueOnce(new Error("firestore indisponible"));
    const failed = await processChariowSale(TOPUP_PAYLOAD, "d1");
    expect(failed.kind).toBe("failed");
    expect(deliveryDoc.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed", error: "firestore indisponible" }),
    );

    applyTopupMock.mockResolvedValue(WALLET);
    const recovered = await processChariowSale(TOPUP_PAYLOAD, "d1");
    expect(recovered).toEqual({ kind: "credited", wallet: WALLET });
    expect(deliveryDoc.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "processed", saleId: "sale-1" }),
    );
  });

  it("message d'erreur tronqué à 1000 caractères sur le document failed", async () => {
    dedupGet.mockResolvedValue({ docs: [] });
    getUserByEmail.mockResolvedValue({ uid: "user-1" });
    applyTopupMock.mockRejectedValue(new Error("x".repeat(1_500)));
    const result = await processChariowSale(TOPUP_PAYLOAD, "d1");
    expect(result.kind).toBe("failed");
    const update = deliveryDoc.update.mock.calls.at(-1)?.[0] as { error: string };
    expect(update.error).toHaveLength(1_000);
  });

  it("dédoublonnage saleId → duplicate_sale, wallet et Auth jamais touchés", async () => {
    dedupGet.mockResolvedValue({
      docs: [{ id: "other-delivery", data: () => ({ status: "processed", saleId: "sale-1" }) }],
    });
    const result = await processChariowSale(TOPUP_PAYLOAD, "d1");
    expect(result).toEqual({ kind: "duplicate_sale" });
    expect(getUserByEmail).not.toHaveBeenCalled();
    expect(applyTopupMock).not.toHaveBeenCalled();
    expect(deliveryDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processed", reason: "duplicate_sale", saleId: "sale-1" }),
    );
  });

  it("utilisateur Firebase introuvable → document failed (reprisable) + user_not_found", async () => {
    dedupGet.mockResolvedValue({ docs: [] });
    getUserByEmail.mockRejectedValue(new Error("no user"));
    const result = await processChariowSale(TOPUP_PAYLOAD, "d1");
    expect(result).toEqual({ kind: "user_not_found" });
    expect(deliveryDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", reason: "firebase_user_not_found", saleId: "sale-1" }),
    );
    expect(applyTopupMock).not.toHaveBeenCalled();
  });

  it("montant invalide → échec métier, document failed reprisable", async () => {
    dedupGet.mockResolvedValue({ docs: [] });
    const result = await processChariowSale(
      { ...TOPUP_PAYLOAD, sale: { ...TOPUP_PAYLOAD.sale, amount: { value: -5, currency: "XAF" } } },
      "d1",
    );
    expect(result.kind).toBe("failed");
    expect(deliveryDoc.update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});

describe("processChariowSale (extension + hors périmètre)", () => {
  it("achat d'extension → settlement Chariow + document processed", async () => {
    dedupGet.mockResolvedValue({ docs: [] });
    settleExtensionMock.mockResolvedValue({ granted: true });
    const payload = {
      event: "successful.sale",
      product: { id: "prod_ext" },
      sale: {
        id: "sale-9",
        status: "completed",
        amount: { value: 50, currency: "XAF" },
        custom_metadata: {
          gen3ia_product: "extension_purchase",
          purchaseId: "p-1",
          userId: "user-1",
          extensionId: "ext-1",
        },
      },
    };
    const result = await processChariowSale(payload, "d1");
    expect(settleExtensionMock).toHaveBeenCalledWith(
      expect.objectContaining({ purchaseId: "p-1", providerRef: "chariow:sale-9", amountMinor: 5_000 }),
    );
    expect(result).toEqual({ kind: "extension_purchase", granted: true });
    expect(deliveryDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processed", kind: "extension_purchase", saleId: "sale-9" }),
    );
  });

  it("vente hors périmètre (ni extension ni topup) → ignorée", async () => {
    dedupGet.mockResolvedValue({ docs: [] });
    const result = await processChariowSale(
      { event: "successful.sale", sale: { id: "s", status: "completed", amount: { value: 1, currency: "XAF" } } },
      "d1",
    );
    expect(result).toEqual({ kind: "ignored" });
    expect(deliveryDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ignored", reason: "not_a_wallet_topup_sale" }),
    );
  });
});

describe("reconnaissance du produit de recharge wallet API (widget boutique prd_llfosdp1)", () => {
  // Achat DIRECT via le widget « Recharge Wallet API » sur la boutique : le
  // checkout n'est pas créé par la plateforme, la vente ne porte AUCUNE
  // custom_metadata — la reconnaissance se fait par identifiant produit
  // (défaut serveur prd_llfosdp1, cf. lib/billing/chariow.ts).
  const WIDGET_TOPUP_PAYLOAD = {
    event: "successful.sale",
    customer: { email: "Client@Example.com" },
    product: { id: "prd_llfosdp1" },
    sale: {
      id: "sale-widget-1",
      status: "completed",
      amount: { value: 5000, currency: "XAF" },
    },
  };

  it("vente prd_llfosdp1 sans métadonnées → reconnue topup et créditée (sans env)", async () => {
    delete process.env.CHARIOW_TOPUP_PRODUCT_ID;
    dedupGet.mockResolvedValue({ docs: [] });
    getUserByEmail.mockResolvedValue({ uid: "user-1" });
    applyTopupMock.mockResolvedValue(WALLET);
    const result = await processChariowSale(WIDGET_TOPUP_PAYLOAD, "d1");
    expect(result).toEqual({ kind: "credited", wallet: WALLET });
    expect(applyTopupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        amountMinor: 500_000,
        currency: "XAF",
        providerReference: "sale-widget-1",
      }),
    );
    expect(deliveryDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processed", saleId: "sale-widget-1", amountMinor: 500_000 }),
    );
  });

  it("surcharge CHARIOW_TOPUP_PRODUCT_ID : le produit configuré est reconnu, le défaut ne l'est plus", async () => {
    process.env.CHARIOW_TOPUP_PRODUCT_ID = "prd_remplacement";
    dedupGet.mockResolvedValue({ docs: [] });
    getUserByEmail.mockResolvedValue({ uid: "user-1" });
    applyTopupMock.mockResolvedValue(WALLET);

    const overridden = await processChariowSale(
      { ...WIDGET_TOPUP_PAYLOAD, product: { id: "prd_remplacement" } },
      "d2",
    );
    expect(overridden).toEqual({ kind: "credited", wallet: WALLET });

    applyTopupMock.mockClear();
    const oldDefault = await processChariowSale(WIDGET_TOPUP_PAYLOAD, "d3");
    expect(oldDefault).toEqual({ kind: "ignored" });
    expect(applyTopupMock).not.toHaveBeenCalled();
    delete process.env.CHARIOW_TOPUP_PRODUCT_ID;
  });

  it("un autre produit boutique sans métadonnées (ex. un plan via widget) reste ignoré", async () => {
    delete process.env.CHARIOW_TOPUP_PRODUCT_ID;
    dedupGet.mockResolvedValue({ docs: [] });
    const result = await processChariowSale(
      { ...WIDGET_TOPUP_PAYLOAD, product: { id: "prd_svqonju7" }, sale: { ...WIDGET_TOPUP_PAYLOAD.sale, id: "sale-plan" } },
      "d1",
    );
    expect(result).toEqual({ kind: "ignored" });
    expect(applyTopupMock).not.toHaveBeenCalled();
    expect(deliveryDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ignored", reason: "not_a_wallet_topup_sale" }),
    );
  });
});

describe("ventes de licences d'espace (boutique « 100Go » prd_645l06yr / « 600Go » prd_vkequ0dn)", () => {
  // Achat DIRECT via les widgets d'espace sur /storage : aucune custom_metadata,
  // reconnaissance par identifiant produit (lib/storage/licences.ts), quota
  // permanent accordé par grantStorageLicence (idempotence par saleId).
  const ESPACE_PAYLOAD = {
    event: "successful.sale",
    customer: { email: "Client@Example.com" },
    product: { id: "prd_645l06yr" },
    sale: {
      id: "sale-espace-1",
      status: "completed",
      amount: { value: 3000, currency: "XAF" },
    },
  };

  it("vente « 100Go » sans métadonnées → licence espace-100 accordée au compte rapproché", async () => {
    dedupGet.mockResolvedValue({ docs: [] });
    getUserByEmail.mockResolvedValue({ uid: "user-1" });
    grantLicenceMock.mockResolvedValue({ licenceId: "espace-100", label: "Espace 100 Go", extraBytes: 100 * 1024 ** 3, granted: true });

    const result = await processChariowSale(ESPACE_PAYLOAD, "d1");
    expect(result).toEqual({ kind: "storage_licence", userId: "user-1", licence: "Espace 100 Go", granted: true });
    expect(grantLicenceMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", saleId: "sale-espace-1", productId: "prd_645l06yr" }),
    );
    expect(grantLicenceMock.mock.calls[0][0].licence.id).toBe("espace-100");
    expect(deliveryDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processed", kind: "storage_licence", licenceId: "espace-100", saleId: "sale-espace-1", granted: true }),
    );
    // Aucun crédit wallet ni renouvellement de plan en parallèle.
    expect(applyTopupMock).not.toHaveBeenCalled();
  });

  it("vente « 600Go » → licence espace-600", async () => {
    dedupGet.mockResolvedValue({ docs: [] });
    getUserByEmail.mockResolvedValue({ uid: "user-2" });
    grantLicenceMock.mockResolvedValue({ licenceId: "espace-600", label: "Espace 600 Go", extraBytes: 600 * 1024 ** 3, granted: true });

    const result = await processChariowSale({ ...ESPACE_PAYLOAD, product: { id: "prd_vkequ0dn" }, sale: { ...ESPACE_PAYLOAD.sale, id: "sale-espace-2" } }, "d2");
    expect(result).toEqual({ kind: "storage_licence", userId: "user-2", licence: "Espace 600 Go", granted: true });
    expect(grantLicenceMock.mock.calls[0][0].licence.id).toBe("espace-600");
  });

  it("vente déjà créditée (granted:false) → livraison clôturée, aucun double quota", async () => {
    dedupGet.mockResolvedValue({ docs: [] });
    getUserByEmail.mockResolvedValue({ uid: "user-1" });
    grantLicenceMock.mockResolvedValue({ licenceId: "espace-100", label: "Espace 100 Go", extraBytes: 100 * 1024 ** 3, granted: false });

    const result = await processChariowSale(ESPACE_PAYLOAD, "d1");
    expect(result).toEqual({ kind: "storage_licence", userId: "user-1", licence: "Espace 100 Go", granted: false });
    expect(deliveryDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processed", granted: false }),
    );
  });

  it("e-mail client sans compte Gen3ia → livraison échec REPRISEABLE (user_not_found)", async () => {
    dedupGet.mockResolvedValue({ docs: [] });
    getUserByEmail.mockRejectedValue(new Error("User not found"));

    const result = await processChariowSale(ESPACE_PAYLOAD, "d1");
    expect(result).toEqual({ kind: "user_not_found" });
    expect(grantLicenceMock).not.toHaveBeenCalled();
    expect(deliveryDoc.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", reason: "firebase_user_not_found", customerEmail: "client@example.com", saleId: "sale-espace-1" }),
    );
  });

  it("statut de vente non créditable → échec (Chariow re-délivrera)", async () => {
    dedupGet.mockResolvedValue({ docs: [] });
    const result = await processChariowSale(
      { ...ESPACE_PAYLOAD, sale: { ...ESPACE_PAYLOAD.sale, status: "refunded" } },
      "d1",
    );
    expect(result.kind).toBe("failed");
    expect(grantLicenceMock).not.toHaveBeenCalled();
  });

  it("surcharge env CHARIOW_ESPACE_100_PRODUCT_ID : le nouveau produit prime, l'ancien est ignoré", async () => {
    process.env.CHARIOW_ESPACE_100_PRODUCT_ID = "prd_remplacement";
    dedupGet.mockResolvedValue({ docs: [] });
    getUserByEmail.mockResolvedValue({ uid: "user-1" });
    grantLicenceMock.mockResolvedValue({ licenceId: "espace-100", label: "Espace 100 Go", extraBytes: 100 * 1024 ** 3, granted: true });

    const overridden = await processChariowSale(
      { ...ESPACE_PAYLOAD, product: { id: "prd_remplacement" } },
      "d2",
    );
    expect(overridden).toEqual({ kind: "storage_licence", userId: "user-1", licence: "Espace 100 Go", granted: true });

    grantLicenceMock.mockClear();
    deliveryDoc.update.mockClear();
    const ancien = await processChariowSale(ESPACE_PAYLOAD, "d3");
    expect(ancien).toEqual({ kind: "ignored" });
    expect(grantLicenceMock).not.toHaveBeenCalled();
  });

  it("la recharge wallet (produit différent) n'est PAS capturée par la branche espace", async () => {
    dedupGet.mockResolvedValue({ docs: [] });
    getUserByEmail.mockResolvedValue({ uid: "user-1" });
    applyTopupMock.mockResolvedValue(WALLET);

    const topupPayload = {
      event: "successful.sale",
      customer: { email: "Client@Example.com" },
      product: { id: "prd_llfosdp1" },
      sale: {
        id: "sale-widget-1",
        status: "completed",
        amount: { value: 5000, currency: "XAF" },
      },
    };
    const result = await processChariowSale(topupPayload, "d1");
    expect(result).toEqual({ kind: "credited", wallet: WALLET });
    expect(grantLicenceMock).not.toHaveBeenCalled();
  });
});

describe("snapshot de charge utile", () => {
  it("sérialisable : valeurs non JSON écartées, dates en ISO", () => {
    const snapshot = buildChariowPayloadSnapshot({ a: 1, b: { c: undefined }, d: new Date(0) });
    expect(snapshot).toEqual({ a: 1, b: {}, d: "1970-01-01T00:00:00.000Z" });
    // Round-trip JSON garanti (ce qui est stocké est re-parsable tel quel).
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("borné ~100 Ko : payload hors norme tronqué et marqué", () => {
    const snapshot = buildChariowPayloadSnapshot({ raw: "x".repeat(120_000) });
    expect(snapshot.__truncated).toBe(true);
    expect((snapshot.raw as string).length).toBe(100_000);
    // Un payload tronqué n'est pas retraitable.
    expect(storedChariowPayload(snapshot)).toBeNull();
  });

  it("storedChariowPayload : null si absent/non objet, payload sinon", () => {
    expect(storedChariowPayload({})).toBeNull();
    expect(storedChariowPayload({ payload: [1, 2] })).toBeNull();
    expect(storedChariowPayload({ payload: { sale: { id: "s" } } })).toEqual({ sale: { id: "s" } });
  });

  it("receivedAtToMillis : Timestamp, Date, nombre, absent → frais", () => {
    expect(receivedAtToMillis(Timestamp.fromMillis(42))).toBe(42);
    expect(receivedAtToMillis(new Date(42))).toBe(42);
    expect(receivedAtToMillis(42)).toBe(42);
    const before = Date.now();
    expect(receivedAtToMillis(undefined)).toBeGreaterThanOrEqual(before);
  });
});

describe("gardes structurelles (convention du dépôt)", () => {
  const routeSource = readFileSync(
    path.join(import.meta.dirname, "../../app/api/webhooks/chariow/route.ts"),
    "utf8",
  );

  it("garde : le webhook délègue au module partagé (plus de claim inline)", () => {
    expect(routeSource).toContain("claimChariowDelivery(");
    expect(routeSource).toContain("processChariowSale(");
    expect(routeSource).toContain("buildChariowPayloadSnapshot(");
    // L'ancien garde « if (snap.exists) return false; » ne doit pas revenir.
    expect(routeSource).not.toContain("snap.exists");
  });
});

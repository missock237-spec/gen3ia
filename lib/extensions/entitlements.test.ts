import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Paiements marketplace : part développeur réellement enregistrée (80/20)
 * sur achat wallet ET settlement Chariow ; échec wallet = achat marqué
 * failed SANS revenu ; idempotence du settlement (déjà payé = rien).
 */

const docUpdate = vi.fn();

vi.mock("@/lib/firebase/admin", () => {
  const makeRef = (path: string) => ({
    __path: path,
    update: docUpdate,
    get: vi.fn(async () => ({ exists: false, data: () => ({}) })),
  });
  return {
    adminDb: {
      collection: vi.fn((name: string) => ({
        doc: vi.fn((id?: string) => makeRef(`${name}/${id ?? "auto"}`)),
      })),
      runTransaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn(txObject)),
    },
  };
});

// Objet transaction rempli par le test (refs → snapshots).
let txDocs: Map<string, { exists: boolean; data: Record<string, unknown> }>;
const txUpdate = vi.fn();
const txSet = vi.fn();
const txCreate = vi.fn();
const txObject = {
  get: vi.fn(async (ref: { __path: string }) => {
    const snap = txDocs?.get(ref.__path);
    return { exists: Boolean(snap?.exists), data: () => snap?.data ?? {} };
  }),
  update: txUpdate,
  set: txSet,
  create: txCreate,
};

const walletMocks = vi.hoisted(() => ({
  getWallet: vi.fn(),
  reserveFunds: vi.fn(),
  settleReservation: vi.fn(),
}));
vi.mock("@/lib/billing/wallet", () => ({
  getWallet: walletMocks.getWallet,
  reserveFunds: walletMocks.reserveFunds,
  settleReservation: walletMocks.settleReservation,
  WALLET_CURRENCY: "XAF",
}));

const repoMocks = vi.hoisted(() => ({
  createExtensionPurchase: vi.fn(),
  createLicense: vi.fn(),
  getEntitlement: vi.fn(),
  getExtension: vi.fn(),
  getExtensionPurchase: vi.fn(),
  markPurchasePaid: vi.fn(),
  upsertEntitlement: vi.fn(),
  addDeveloperRevenue: vi.fn(),
}));
vi.mock("@/lib/extensions/repository", () => repoMocks);

const chariowMocks = vi.hoisted(() => ({
  createChariowExtensionCheckout: vi.fn(),
  getChariowStoreUrl: vi.fn(),
}));
vi.mock("@/lib/billing/chariow", () => chariowMocks);

import { purchaseWithWallet, settleChariowExtensionPurchase } from "./entitlements";
import type { ExtensionDoc } from "./repository";

function extensionDoc(overrides: Partial<ExtensionDoc> = {}): ExtensionDoc {
  return {
    id: "ext-pro",
    name: "Extension Pro",
    description: "",
    category: "productivity",
    tags: [],
    developerId: "dev-1",
    developerName: "Dev",
    projectId: "p1",
    status: "approved",
    permissions: [],
    pricing: { model: "one_time", amountMinor: 500_000, currency: "XAF" },
    latestVersion: "1.0.0",
    approvedVersion: "1.0.0",
    stats: { installs: 0, ratingSum: 0, ratingCount: 0, executions: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as ExtensionDoc;
}

beforeEach(() => {
  docUpdate.mockReset().mockResolvedValue(undefined);
  txUpdate.mockReset();
  txSet.mockReset();
  txCreate.mockReset();
  txObject.get.mockClear();
  walletMocks.getWallet.mockReset().mockResolvedValue({ balanceMinor: 1_000_000 });
  walletMocks.reserveFunds.mockReset().mockResolvedValue(undefined);
  walletMocks.settleReservation.mockReset().mockResolvedValue(undefined);
  for (const fn of Object.values(repoMocks)) (fn as ReturnType<typeof vi.fn>).mockReset();
  repoMocks.createExtensionPurchase.mockResolvedValue({ id: "pur-1" });
  repoMocks.markPurchasePaid.mockResolvedValue({});
  repoMocks.upsertEntitlement.mockResolvedValue({});
  repoMocks.createLicense.mockResolvedValue({});
  repoMocks.addDeveloperRevenue.mockResolvedValue(undefined);
  txDocs = new Map();
});

describe("purchaseWithWallet (wallet Gen3ia)", () => {
  it("achat réussi → revenu développeur enregistré avec le bon montant/devise", async () => {
    const result = await purchaseWithWallet({
      userId: "u1",
      extension: extensionDoc(),
      reference: "ext-install:ext-pro:u1",
    });

    expect(result.mode).toBe("wallet");
    expect(walletMocks.reserveFunds).toHaveBeenCalledWith(expect.objectContaining({ amountMinor: 500_000 }));
    expect(walletMocks.settleReservation).toHaveBeenCalled();
    expect(repoMocks.markPurchasePaid).toHaveBeenCalledWith("pur-1", expect.stringContaining("wallet:"));
    expect(repoMocks.addDeveloperRevenue).toHaveBeenCalledTimes(1);
    expect(repoMocks.addDeveloperRevenue).toHaveBeenCalledWith(expect.objectContaining({
      developerId: "dev-1",
      extensionId: "ext-pro",
      purchaseId: "pur-1",
      grossAmountMinor: 500_000,
      currency: "XAF",
    }));
    expect(repoMocks.upsertEntitlement).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1", source: "purchase", purchaseId: "pur-1",
    }));
  });

  it("échec de réservation wallet → achat marqué failed, AUCUN revenu, erreur propagée", async () => {
    walletMocks.reserveFunds.mockRejectedValue(new Error("Fonds insuffisants."));

    await expect(purchaseWithWallet({
      userId: "u1",
      extension: extensionDoc(),
      reference: "ext-install:ext-pro:u1",
    })).rejects.toThrow("Fonds insuffisants.");

    expect(docUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(repoMocks.addDeveloperRevenue).not.toHaveBeenCalled();
    expect(repoMocks.markPurchasePaid).not.toHaveBeenCalled();
  });

  it("échec d'enregistrement du revenu → l'ACHAT reste validé (best-effort journalisé)", async () => {
    repoMocks.addDeveloperRevenue.mockRejectedValue(new Error("firestore down"));

    const result = await purchaseWithWallet({
      userId: "u1",
      extension: extensionDoc(),
      reference: "ref",
    });
    expect(result.mode).toBe("wallet");
    expect(repoMocks.markPurchasePaid).toHaveBeenCalled();
    expect(repoMocks.upsertEntitlement).toHaveBeenCalled();
  });
});

describe("settleChariowExtensionPurchase (webhook Pulse)", () => {
  function seedHappyPath() {
    repoMocks.getExtensionPurchase.mockResolvedValue({
      id: "pur-9", userId: "u1", extensionId: "ext-pro", provider: "chariow",
      amountMinor: 500_000, currency: "XAF", kind: "one_time", status: "pending",
    });
    repoMocks.getExtension.mockResolvedValue(extensionDoc());
    txDocs.set("extensionPurchases/pur-9", { exists: true, data: { status: "pending", kind: "one_time" } });
    txDocs.set("extensions/ext-pro", { exists: true, data: extensionDoc() });
    txDocs.set("extensionEntitlements/ext-pro__u1", { exists: false, data: {} });
  }

  it("settlement → entitlement + license et revenu développeur enregistré UNE fois", async () => {
    seedHappyPath();
    const result = await settleChariowExtensionPurchase({
      purchaseId: "pur-9",
      providerRef: "chariow:sale-42",
      saleId: "sale-42",
    });

    expect(result.granted).toBe(true);
    expect(txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ __path: "extensionPurchases/pur-9" }),
      expect.objectContaining({ status: "paid" }),
    );
    expect(txCreate).toHaveBeenCalled(); // license
    expect(repoMocks.addDeveloperRevenue).toHaveBeenCalledTimes(1);
    expect(repoMocks.addDeveloperRevenue).toHaveBeenCalledWith(expect.objectContaining({
      developerId: "dev-1", purchaseId: "pur-9", grossAmountMinor: 500_000, currency: "XAF",
    }));
  });

  it("déjà payé (rejoue webhook) → granted:false, AUCUN doublon de revenu", async () => {
    repoMocks.getExtensionPurchase.mockResolvedValue({
      id: "pur-9", userId: "u1", extensionId: "ext-pro", provider: "chariow",
      amountMinor: 500_000, currency: "XAF", kind: "one_time", status: "paid",
      providerRef: "chariow:sale-42",
    });

    const result = await settleChariowExtensionPurchase({
      purchaseId: "pur-9",
      providerRef: "chariow:sale-42",
    });
    expect(result.granted).toBe(false);
    expect(repoMocks.addDeveloperRevenue).not.toHaveBeenCalled();
  });
});

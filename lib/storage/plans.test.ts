import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 150 — Plans de stockage permanent.
 *
 * 1 Go offert à chaque compte (plan free), 5 Go pour 2,5 €/mois et 10 Go
 * pour 5 €/mois. Renouvellement lazy idempotent (référence déterministe par
 * période), retour au plan free sans destruction des fichiers quand le
 * portefeuille ne couvre plus l'échéance.
 */

const docGet = vi.fn();
const docSet = vi.fn();

/** Simule le document storagePlans/{userId} : les set() mettent à jour l'état lu. */
let planStore: Record<string, unknown> | null;
const docRef = { get: docGet, set: docSet };

/** Simule les licences d'espace accordées (collection storageLicences). */
let licenceDocs: Array<{ data: () => Record<string, unknown> }> = [];
const licencesWhereGet = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn((name: string) =>
      name === "storageLicences"
        ? { where: vi.fn(() => ({ limit: vi.fn(() => ({ get: licencesWhereGet })) })) }
        : { doc: vi.fn(() => docRef) },
    ),
  },
}));

const getWalletMock = vi.fn();
const reserveFundsMock = vi.fn();
const settleReservationMock = vi.fn();
vi.mock("@/lib/billing/wallet", () => ({
  getWallet: (...args: unknown[]) => getWalletMock(...args),
  reserveFunds: (...args: unknown[]) => reserveFundsMock(...args),
  settleReservation: (...args: unknown[]) => settleReservationMock(...args),
}));

vi.mock("@/lib/r2fs", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TIMESTAMP" },
  Timestamp: { fromMillis: (ms: number) => ({ ms, toMillis: () => ms }) },
}));

import {
  STORAGE_PLANS,
  changeStoragePlan,
  describeStorageOffer,
  findStoragePlan,
  getStorageProfile,
  getQuotaBytesForUser,
} from "./plans";

const DAY = 24 * 60 * 60 * 1000;

/** Simule un Timestamp Firestore (expose toMillis comme le vrai). */
const ts = (ms: number) => ({ ms, toMillis: () => ms });

beforeEach(() => {
  vi.clearAllMocks();
  planStore = null;
  licenceDocs = [];
  licencesWhereGet.mockImplementation(async () => ({ docs: licenceDocs }));
  docGet.mockImplementation(() => ({ exists: planStore !== null, data: () => planStore }));
  docSet.mockImplementation((data: Record<string, unknown>) => {
    planStore = { ...(planStore ?? {}), ...data };
    return Promise.resolve();
  });
  getWalletMock.mockResolvedValue({ currency: "EUR", availableMinor: 100000 });
  reserveFundsMock.mockResolvedValue({});
  settleReservationMock.mockResolvedValue({});
});

describe("catalogue des plans", () => {
  it("expose exactement les quotas et tarifs demandés", () => {
    expect(STORAGE_PLANS).toHaveLength(3);
    const free = findStoragePlan("free");
    const pro5 = findStoragePlan("storage-pro5");
    const pro10 = findStoragePlan("storage-pro10");
    expect(free?.quotaBytes).toBe(1024 ** 3);
    expect(free?.priceMinor).toBe(0);
    expect(pro5?.quotaBytes).toBe(5 * 1024 ** 3);
    expect(pro5?.priceMinor).toBe(250); // 2,5 €/mois
    expect(pro5?.priceLabel).toBe("2,5 €/mois");
    expect(pro10?.quotaBytes).toBe(10 * 1024 ** 3);
    expect(pro10?.priceMinor).toBe(500); // 5 €/mois
    expect(pro10?.priceLabel).toBe("5 €/mois");
  });

  it("rejette les identifiants inconnus", () => {
    expect(findStoragePlan("storage-pro50")).toBeUndefined();
  });
});

describe("getStorageProfile", () => {
  it("accorde le plan free (1 Go) à un compte sans historique", async () => {
    const profile = await getStorageProfile("u-new");
    expect(profile.plan.id).toBe("free");
    expect(profile.plan.quotaBytes).toBe(1024 ** 3);
    expect(profile.renewalAt).toBeNull();
    expect(reserveFundsMock).not.toHaveBeenCalled();
  });

  it("renvoie le quota du plan payant tant que l'échéance n'est pas atteinte", async () => {
    planStore = { planId: "storage-pro5", renewalAt: ts(Date.now() + 10 * DAY) };
    const profile = await getStorageProfile("u-pro");
    expect(profile.plan.quotaBytes).toBe(5 * 1024 ** 3);
    expect(reserveFundsMock).not.toHaveBeenCalled();
    expect(await getQuotaBytesForUser("u-pro")).toBe(5 * 1024 ** 3);
  });

  it("ajoute les licences d'espace Chariow au quota du plan (quota EFFECTIF)", async () => {
    const GO = 1024 ** 3;
    planStore = { planId: "storage-pro5", renewalAt: ts(Date.now() + 10 * DAY) };
    licenceDocs = [
      { data: () => ({ licenceId: "espace-100", label: "Espace 100 Go", extraBytes: 100 * GO }) },
      { data: () => ({ licenceId: "espace-600", label: "Espace 600 Go", extraBytes: 600 * GO }) },
    ];
    const profile = await getStorageProfile("u-pro");
    expect(profile.licenceExtraBytes).toBe(700 * GO);
    expect(profile.licences).toHaveLength(2);
    // Quota effectif = plan (5 Go) + licences (700 Go) — les uploads suivent.
    expect(await getQuotaBytesForUser("u-pro")).toBe(705 * GO);
  });

  it("l'espace acheté SURVIT à une retombée au plan free (échéance impayée)", async () => {
    const GO = 1024 ** 3;
    reserveFundsMock.mockRejectedValue(new Error("Insufficient wallet balance for this execution."));
    planStore = { planId: "storage-pro5", renewalAt: ts(Date.now() - DAY) };
    licenceDocs = [
      { data: () => ({ licenceId: "espace-600", label: "Espace 600 Go", extraBytes: 600 * GO }) },
    ];
    const profile = await getStorageProfile("u-broke");
    expect(profile.plan.id).toBe("free");
    expect(profile.licenceExtraBytes).toBe(600 * GO);
    expect(await getQuotaBytesForUser("u-broke")).toBe(601 * GO); // 1 Go free + licence
  });

  it("une panne de lecture des licences ne masque jamais le plan (repli à zéro)", async () => {
    planStore = { planId: "storage-pro5", renewalAt: ts(Date.now() + 10 * DAY) };
    licencesWhereGet.mockRejectedValue(new Error("Firestore indisponible"));
    const profile = await getStorageProfile("u-pro");
    expect(profile.plan.quotaBytes).toBe(5 * 1024 ** 3);
    expect(profile.licenceExtraBytes).toBe(0);
    expect(profile.licences).toEqual([]);
  });

  it("renouvelle automatiquement une échéance passée quand le solde couvre", async () => {
    planStore = { planId: "storage-pro10", renewalAt: ts(Date.now() - DAY) };
    const profile = await getStorageProfile("u-due");
    expect(reserveFundsMock).toHaveBeenCalledTimes(1);
    expect(reserveFundsMock.mock.calls[0][0].amountMinor).toBe(500);
    expect(reserveFundsMock.mock.calls[0][0].reference).toMatch(/^storageplan_storage-pro10_\d{4}-\d{2}$/);
    expect(settleReservationMock).toHaveBeenCalledTimes(1);
    expect(profile.plan.id).toBe("storage-pro10");
    expect(profile.renewalAt).toBeGreaterThan(Date.now() + 28 * DAY);
  });

  it("retombe sur le plan free (fichiers conservés) quand le solde est insuffisant", async () => {
    reserveFundsMock.mockRejectedValue(new Error("Insufficient wallet balance for this execution."));
    planStore = { planId: "storage-pro5", renewalAt: ts(Date.now() - DAY) };
    const profile = await getStorageProfile("u-broke");
    expect(profile.plan.id).toBe("free");
    expect(profile.plan.quotaBytes).toBe(1024 ** 3);
    expect(profile.lastRenewalError).toContain("Insufficient wallet balance");
    expect(planStore).toMatchObject({ planId: "free", renewalAt: null });
  });
});

describe("changeStoragePlan", () => {
  it("facture immédiatement un upgrade et étend le quota", async () => {
    const profile = await changeStoragePlan("u-up", "storage-pro10");
    expect(reserveFundsMock).toHaveBeenCalledTimes(1);
    expect(reserveFundsMock.mock.calls[0][0].amountMinor).toBe(500);
    expect(settleReservationMock).toHaveBeenCalledTimes(1);
    expect(docSet).toHaveBeenCalled();
    expect(profile.plan.quotaBytes).toBe(10 * 1024 ** 3);
    expect(profile.renewalAt).toBeGreaterThan(Date.now() + 29 * DAY);
  });

  it("un downgrade vers le plan free est gratuit et immédiat", async () => {
    planStore = { planId: "storage-pro5", renewalAt: ts(Date.now() + 20 * DAY) };
    const profile = await changeStoragePlan("u-down", "free");
    expect(reserveFundsMock).not.toHaveBeenCalled();
    expect(profile.plan.id).toBe("free");
    expect(profile.renewalAt).toBeNull();
  });

  it("propage l'erreur quand le portefeuille ne couvre pas l'upgrade", async () => {
    reserveFundsMock.mockRejectedValue(new Error("Insufficient wallet balance for this execution."));
    await expect(changeStoragePlan("u-poor", "storage-pro5")).rejects.toThrow("Insufficient wallet balance");
    expect(planStore).toBeNull(); // aucun changement de plan appliqué
  });

  it("rejette un identifiant de plan inconnu", async () => {
    await expect(changeStoragePlan("u-x", "storage-pro50" as never)).rejects.toThrow("Plan de stockage inconnu.");
  });
});

describe("describeStorageOffer", () => {
  it("expose les plans et le solde disponible du portefeuille", async () => {
    const offer = await describeStorageOffer("u-offer");
    expect(offer.plans).toHaveLength(3);
    expect(offer.wallet.availableMinor).toBe(100000);
  });
});

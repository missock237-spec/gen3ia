import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Licences d'espace de stockage (achats DIRECTS boutique Chariow) :
 * reconnaissance par identifiant produit (défauts boutique + surcharge env),
 * accord IDEMPOTENT par vente (document `chariow_${saleId}`, barrière atomique
 * create()) et agrégation du quota additionnel permanent.
 */

const licenceDoc = { get: vi.fn(), create: vi.fn() };
const licencesWhereGet = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn((name: string) => {
      expect(name).toBe("storageLicences");
      return {
        doc: vi.fn(() => licenceDoc),
        where: vi.fn(() => ({ limit: vi.fn(() => ({ get: licencesWhereGet })) })),
      };
    }),
  },
}));

vi.mock("@/lib/r2fs", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TIMESTAMP" },
}));

import {
  STORAGE_LICENCES,
  grantStorageLicence,
  listStorageLicences,
  resolveStorageLicenceForProduct,
  resolveStorageLicenceProductId,
  sumStorageLicenceExtraBytes,
} from "./licences";

const GO = 1024 ** 3;

beforeEach(() => {
  licenceDoc.get.mockReset();
  licenceDoc.create.mockReset();
  licenceDoc.create.mockResolvedValue(undefined);
  licencesWhereGet.mockReset();
  delete process.env.CHARIOW_ESPACE_100_PRODUCT_ID;
  delete process.env.CHARIOW_ESPACE_600_PRODUCT_ID;
});

describe("catalogue des licences d'espace (quantités modifiées boutique)", () => {
  it("expose exactement les deux licences publiées : 100 Go et 600 Go permanents", () => {
    expect(STORAGE_LICENCES.map((licence) => licence.id)).toEqual(["espace-100", "espace-600"]);
    expect(STORAGE_LICENCES.map((licence) => licence.extraBytes)).toEqual([100 * GO, 600 * GO]);
    // Prix alignés sur les produits boutique réels (vitrine vérifiée 2026-10-25).
    expect(STORAGE_LICENCES.map((licence) => licence.priceLabel)).toEqual(["3 000 FCFA", "6 000 FCFA"]);
  });

  it("résout les produits boutique par défaut (prd_645l06yr, prd_vkequ0dn)", () => {
    const [espace100, espace600] = STORAGE_LICENCES;
    expect(resolveStorageLicenceProductId(espace100)).toBe("prd_645l06yr");
    expect(resolveStorageLicenceProductId(espace600)).toBe("prd_vkequ0dn");
  });

  it("la surcharge env REMPLACE le défaut boutique (même convention que les plans)", () => {
    process.env.CHARIOW_ESPACE_100_PRODUCT_ID = "prd_remplacement";
    expect(resolveStorageLicenceProductId(STORAGE_LICENCES[0])).toBe("prd_remplacement");
    expect(resolveStorageLicenceProductId(STORAGE_LICENCES[1])).toBe("prd_vkequ0dn");
  });

  it("reconnaît les ventes d'espace par identifiant produit et ignore les autres", () => {
    expect(resolveStorageLicenceForProduct("prd_645l06yr")?.id).toBe("espace-100");
    expect(resolveStorageLicenceForProduct("prd_vkequ0dn")?.id).toBe("espace-600");
    // Ni la recharge wallet, ni les plans, ni un produit inconnu.
    expect(resolveStorageLicenceForProduct("prd_llfosdp1")).toBeNull();
    expect(resolveStorageLicenceForProduct("prd_svqonju7")).toBeNull();
    expect(resolveStorageLicenceForProduct("produit_inconnu")).toBeNull();
    expect(resolveStorageLicenceForProduct("")).toBeNull();
    expect(resolveStorageLicenceForProduct(null)).toBeNull();
    expect(resolveStorageLicenceForProduct(undefined)).toBeNull();
  });
});

describe("grantStorageLicence (idempotence par vente)", () => {
  const licence = STORAGE_LICENCES[0];

  it("crée le document chariow_${saleId} et accorde le quota", async () => {
    const grant = await grantStorageLicence({ userId: "user-1", licence, saleId: "sal_1", productId: "prd_645l06yr" });
    expect(grant).toEqual({ licenceId: "espace-100", label: "Espace 100 Go", extraBytes: 100 * GO, granted: true });
    expect(licenceDoc.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        licenceId: "espace-100",
        extraBytes: 100 * GO,
        saleId: "sal_1",
        productId: "prd_645l06yr",
        source: "chariow_storefront",
      }),
    );
  });

  it("ne crée JAMAIS deux quotas pour une même vente (re-délivrance / course)", async () => {
    // ALREADY_EXISTS : le document de la vente existe déjà (première livraison traitée).
    licenceDoc.create.mockRejectedValueOnce(new Error("ALREADY_EXISTS: document already exists"));
    const grant = await grantStorageLicence({ userId: "user-1", licence, saleId: "sal_1", productId: "prd_645l06yr" });
    expect(grant.granted).toBe(false);
    expect(grant.extraBytes).toBe(100 * GO);
  });

  it("refuse un userId ou un saleId vide (garde-fou d'appel)", async () => {
    await expect(grantStorageLicence({ userId: "", licence, saleId: "sal_1", productId: "prd_645l06yr" })).rejects.toThrow("userId");
    await expect(grantStorageLicence({ userId: "user-1", licence, saleId: "  ", productId: "prd_645l06yr" })).rejects.toThrow("sale reference");
  });
});

describe("agrégation du quota additionnel", () => {
  it("somme les licences accordées (plan + licences = quota effectif)", async () => {
    licencesWhereGet.mockResolvedValue({
      docs: [
        { data: () => ({ licenceId: "espace-100", label: "Espace 100 Go", extraBytes: 100 * GO, createdAt: { toMillis: () => 111 } }) },
        { data: () => ({ licenceId: "espace-600", label: "Espace 600 Go", extraBytes: 600 * GO, createdAt: { toMillis: () => 222 } }) },
      ],
    });
    expect(await sumStorageLicenceExtraBytes("user-1")).toBe(700 * GO);
    const licences = await listStorageLicences("user-1");
    expect(licences).toHaveLength(2);
    expect(licences[0]).toMatchObject({ licenceId: "espace-100", extraBytes: 100 * GO, grantedAt: 111 });
  });

  it("ignore les documents illisibles et les quotas non positifs (défense en profondeur)", async () => {
    licencesWhereGet.mockResolvedValue({
      docs: [
        { data: () => ({ extraBytes: "pas-un-nombre" }) },
        { data: () => ({ extraBytes: 0 }) },
        { data: () => ({ licenceId: "espace-100", label: "Espace 100 Go", extraBytes: 100 * GO }) },
      ],
    });
    expect(await sumStorageLicenceExtraBytes("user-1")).toBe(100 * GO);
  });

  it("un userId vide ne déclenche aucune lecture Firestore", async () => {
    expect(await listStorageLicences("")).toEqual([]);
    expect(await sumStorageLicenceExtraBytes("")).toBe(0);
    expect(licencesWhereGet).not.toHaveBeenCalled();
  });
});

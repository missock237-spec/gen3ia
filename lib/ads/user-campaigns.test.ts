import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GEN ADS (self-service utilisateur) :
 *  - validation self-service (catalogue d'emplacements, bornes) ;
 *  - construction de l'inventaire de diffusion (emplacements × créations) ;
 *  - synchronisation : suppression de l'ancien inventaire, republication
 *    uniquement si la campagne est ACTIVE ;
 *  - quota de campagnes par utilisateur (MAX_CAMPAIGNS_PER_USER).
 */

// Chaînable : where().limit().get() — chaque appel renvoie l'API complète.
const queryGet = vi.fn();
const docSet = vi.fn(async () => undefined);
const docGet = vi.fn();
const docDelete = vi.fn(async () => undefined);

function makeChain() {
  const api = {
    where: vi.fn(() => api),
    limit: vi.fn(() => api),
    get: vi.fn(() => queryGet()),
    count: vi.fn(() => ({ get: vi.fn(async () => ({ data: () => ({ count: 0 }) })) })),
  };
  return api;
}

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => {
      const chain = makeChain();
      return {
        where: chain.where,
        limit: chain.limit,
        get: chain.get,
        count: chain.count,
        doc: vi.fn((id: string) => ({
          id,
          set: docSet,
          delete: docDelete,
          get: () => docGet(),
        })),
      };
    }),
  },
}));

import {
  AD_PLACEMENT_IDS,
  MAX_CAMPAIGNS_PER_USER,
  MAX_USER_CREATIVES,
  MAX_USER_PLACEMENTS,
  buildInventoryEntries,
  createUserCampaign,
  syncCampaignInventory,
  validateUserCampaignInput,
} from "./user-campaigns";
import type { AdCampaign, AdCampaignInput } from "./campaigns";

function validInput(): AdCampaignInput {
  return {
    ownerId: "user-1",
    name: "Ma campagne boutique",
    advertiserName: "Ma Boutique SARL",
    objective: "traffic",
    status: "active",
    dailyBudgetMinor: 5000,
    currency: "XAF",
    bidStrategy: "balanced",
    targeting: { placements: ["response_inline", "results"] },
    creatives: [
      {
        headline: "−30% sur toute la collection",
        targetUrl: "https://ma-boutique.example/promo",
        ctaLabel: "En profiter",
      },
      {
        headline: "Nouvelle collection automne",
        description: "Des pièces uniques, livrées en 48h.",
        targetUrl: "https://ma-boutique.example/automne",
        imageUrl: "https://ma-boutique.example/banniere.jpg",
      },
    ],
  };
}

function campaign(overrides: Partial<AdCampaign> = {}): AdCampaign {
  return {
    id: "c-1",
    ownerId: "user-1",
    name: "Ma campagne boutique",
    advertiserName: "Ma Boutique SARL",
    objective: "traffic",
    status: "active",
    dailyBudgetMinor: 5000,
    currency: "XAF",
    bidStrategy: "balanced",
    targeting: { placements: ["response_inline"] },
    creatives: [{ headline: "−30% sur toute la collection", targetUrl: "https://ma-boutique.example/promo" }],
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queryGet.mockResolvedValue({ docs: [] });
  docGet.mockResolvedValue({ exists: false, data: () => ({}), get: () => undefined });
});

/* ------------------------------------------------------------------ */
/* Catalogue public                                                    */
/* ------------------------------------------------------------------ */

describe("AD_PLACEMENTS — catalogue Gen Ads", () => {
  it("expose l'emplacement des réponses de l'IA (demande utilisateur)", () => {
    expect(AD_PLACEMENT_IDS).toContain("response_inline");
    expect(AD_PLACEMENT_IDS).toContain("results");
    expect(AD_PLACEMENT_IDS).toContain("settings");
  });
});

/* ------------------------------------------------------------------ */
/* Validation self-service                                             */
/* ------------------------------------------------------------------ */

describe("validateUserCampaignInput — garde-fous self-service", () => {
  it("valide une campagne utilisateur complète", () => {
    const normalized = validateUserCampaignInput(validInput());
    expect(normalized.name).toBe("Ma campagne boutique");
    expect(normalized.advertiserName).toBe("Ma Boutique SARL");
    expect(normalized.targeting.placements).toEqual(["response_inline", "results"]);
  });

  it("rejette un emplacement hors catalogue public", () => {
    expect(() =>
      validateUserCampaignInput({ ...validInput(), targeting: { placements: ["secret-admin-zone"] } }),
    ).toThrow(/Emplacement publicitaire inconnu/);
  });

  it("rejette plus d'emplacements que la borne self-service", () => {
    // Emplacements valides du catalogue, répétés au-delà de la borne :
    // la validation self-service doit compter les occurrences.
    const placements = Array.from({ length: MAX_USER_PLACEMENTS + 1 }, () => AD_PLACEMENT_IDS[0]);
    expect(() =>
      validateUserCampaignInput({ ...validInput(), targeting: { placements } }),
    ).toThrow(/au plus \d+ emplacements/);
  });

  it("rejette plus de créations que la borne self-service", () => {
    const creatives = Array.from({ length: MAX_USER_CREATIVES + 1 }, (_, index) => ({
      headline: `Créa numéro ${index + 1}`,
      targetUrl: "https://ma-boutique.example",
    }));
    expect(() => validateUserCampaignInput({ ...validInput(), creatives })).toThrow(/au plus \d+ créations/);
  });

  it("rejette un nom d'annonceur trop court", () => {
    expect(() => validateUserCampaignInput({ ...validInput(), advertiserName: "A" })).toThrow(/annonceur/);
  });

  it("réutilise la validation PRO sous-jacente (URL de créa)", () => {
    expect(() =>
      validateUserCampaignInput({ ...validInput(), creatives: [{ headline: "Titre valide", targetUrl: "pas-une-url" }] }),
    ).toThrow(/URL valide/);
  });
});

/* ------------------------------------------------------------------ */
/* Inventaire de diffusion                                             */
/* ------------------------------------------------------------------ */

describe("buildInventoryEntries — publication placements × créations", () => {
  it("produit une annonce par emplacement × création, ACTIVE par défaut", () => {
    const entries = buildInventoryEntries(
      campaign({
        targeting: { placements: ["response_inline", "results"] },
        creatives: validInput().creatives.map((creative) => ({
          headline: creative.headline,
          targetUrl: creative.targetUrl,
          ...(creative.imageUrl ? { imageUrl: creative.imageUrl } : {}),
        })),
      }),
    );
    expect(entries).toHaveLength(4); // 2 emplacements × 2 créations
    expect(entries.every((entry) => entry.enabled)).toBe(true);
    expect(entries.every((entry) => entry.campaignId === "c-1")).toBe(true);
    expect(entries.every((entry) => entry.ownerUserId === "user-1")).toBe(true);
    expect(new Set(entries.map((entry) => entry.placement))).toEqual(new Set(["response_inline", "results"]));
  });

  it("désactive les annonces d'une campagne en pause", () => {
    const entries = buildInventoryEntries(campaign({ status: "paused" }));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => !entry.enabled)).toBe(true);
  });

  it("utilise le format image quand la créa a une image, link sinon", () => {
    const entries = buildInventoryEntries(
      campaign({
        creatives: [
          { headline: "Avec image", targetUrl: "https://example.com", imageUrl: "https://example.com/i.jpg" },
          { headline: "Sans image", targetUrl: "https://example.com" },
        ],
      }),
    );
    expect(entries.filter((entry) => entry.format === "image")).toHaveLength(1);
    expect(entries.filter((entry) => entry.format === "link")).toHaveLength(1);
  });

  it("affiche le nom de l'annonceur, avec repli sur le nom de campagne", () => {
    expect(buildInventoryEntries(campaign())[0].advertiser).toBe("Ma Boutique SARL");
    expect(buildInventoryEntries(campaign({ advertiserName: undefined }))[0].advertiser).toBe("Ma campagne boutique");
  });
});

/* ------------------------------------------------------------------ */
/* Synchronisation Firestore                                           */
/* ------------------------------------------------------------------ */

describe("syncCampaignInventory — cycle de diffusion", () => {
  it("supprime l'ancien inventaire puis republie si ACTIVE", async () => {
    const staleRef = { delete: vi.fn(async () => undefined) };
    queryGet.mockResolvedValueOnce({ docs: [{ id: "ad-old", ref: staleRef }] });

    const published = await syncCampaignInventory(campaign());

    expect(staleRef.delete).toHaveBeenCalledTimes(1);
    expect(published).toBeGreaterThan(0);
    expect(docSet).toHaveBeenCalledTimes(published);
  });

  it("ne publie RIEN pour une campagne en pause (inventaire vidé)", async () => {
    const staleRef = { delete: vi.fn(async () => undefined) };
    queryGet.mockResolvedValueOnce({ docs: [{ id: "ad-old", ref: staleRef }] });

    const published = await syncCampaignInventory(campaign({ status: "paused" }));

    expect(published).toBe(0);
    expect(staleRef.delete).toHaveBeenCalledTimes(1);
    expect(docSet).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Quota utilisateur                                                   */
/* ------------------------------------------------------------------ */

describe("createUserCampaign — quota self-service", () => {
  it("refuse la création au-delà du quota par utilisateur", async () => {
    const existing = Array.from({ length: MAX_CAMPAIGNS_PER_USER }, (_, index) => ({
      id: `existing-${index}`,
      data: () => ({ ownerId: "user-1", name: `Campagne ${index}` }),
    }));
    queryGet.mockResolvedValue({ docs: existing });

    await expect(createUserCampaign("user-1", validInput())).rejects.toThrow(/Quota atteint/);
    expect(docSet).not.toHaveBeenCalled();
  });

  it("crée et publie la campagne quand le quota est respecté", async () => {
    queryGet.mockResolvedValue({ docs: [] });

    const { campaign: created, publishedAds } = await createUserCampaign("user-1", validInput());

    expect(created.ownerId).toBe("user-1");
    expect(created.status).toBe("active");
    expect(publishedAds).toBe(4); // 2 emplacements × 2 créations
  });
});

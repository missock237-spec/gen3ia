import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MARKETPLACE D'AGENTS — ANNONCES & AVIS (V2 — Task 114-c) :
 * gardes PURES (canHireListing, canRateListing, rateForListing, tri du
 * catalogue), bornes de schéma, publication (upsert par agent) et avis
 * (stats corrigées) — mocks adminDb selon le pattern mission-escrow /
 * outcome-credits.
 */

const mocks = vi.hoisted(() => {
  const makeDoc = () => ({ get: vi.fn(), set: vi.fn() });
  return {
    listingDoc: makeDoc(),
    hireDoc: makeDoc(),
    reviewDoc: makeDoc(),
    queryGet: vi.fn(),
    runTransaction: vi.fn(),
    collection: vi.fn((name: string) => ({
      doc: vi.fn(() =>
        name === "agentListings" ? mocks.listingDoc : name === "agentListingHires" ? mocks.hireDoc : mocks.reviewDoc,
      ),
      where: vi.fn(() => ({ limit: vi.fn(() => ({ get: mocks.queryGet })) })),
    })),
    getAgentForOwner: vi.fn(),
  };
});

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: mocks.collection,
    runTransaction: (...args: unknown[]) => mocks.runTransaction(...args),
  },
}));

vi.mock("@/lib/agents/repository", () => ({
  getAgentForOwner: mocks.getAgentForOwner,
}));

import { HttpError } from "@/lib/security/http-errors";
import {
  AgentListingSchema,
  ListingPricingSchema,
  ListingReviewSchema,
  canHireListing,
  canRateListing,
  compareListingsForSort,
  publishAgentListing,
  rateForListing,
  updateAgentListing,
  upsertListingReview,
  type AgentListing,
} from "./agent-listings";

function listingFixture(overrides: Record<string, unknown> = {}): AgentListing {
  return AgentListingSchema.parse({
    listingId: "l1",
    agentId: "a1",
    ownerId: "owner-1",
    title: "Agent marketing",
    description: "Un agent pour vos campagnes.",
    pricing: { model: "per_mission", priceMinor: 5_000 },
    status: "published",
    stats: { hires: 0, ratingSum: 0, ratingCount: 0 },
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  });
}

function hireFixture(overrides: Record<string, unknown> = {}) {
  return {
    hireId: "h1",
    listingId: "l1",
    tenantId: "tenant-1",
    ownerId: "owner-1",
    agentId: "a1",
    executionId: "exec-1",
    runId: "run-1",
    objective: "Lancer une campagne",
    priceMinor: 10_000,
    commissionBps: 2_000,
    status: "completed",
    createdAtMs: 1,
    ...overrides,
  };
}

beforeEach(() => {
  for (const doc of [mocks.listingDoc, mocks.hireDoc, mocks.reviewDoc]) {
    doc.get.mockReset();
    doc.set.mockReset();
  }
  mocks.queryGet.mockReset().mockResolvedValue({ docs: [] });
  mocks.runTransaction.mockReset();
  mocks.getAgentForOwner.mockReset();
});

describe("canHireListing (pur)", () => {
  const listing = { status: "published" as const, ownerId: "owner-1" };

  it("annonce publiée + autre utilisateur → ok", () => {
    expect(canHireListing(listing, "tenant-1")).toEqual({ ok: true });
  });

  it("auto-location interdite (reason self_hire)", () => {
    expect(canHireListing(listing, "owner-1")).toEqual({ ok: false, reason: "self_hire" });
  });

  it("annonce non publiée (draft/suspended) → indisponible", () => {
    expect(canHireListing({ ...listing, status: "draft" }, "tenant-1")).toEqual({ ok: false, reason: "unavailable" });
    expect(canHireListing({ ...listing, status: "suspended" }, "tenant-1")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("identifiant de locataire vide → non authentifié", () => {
    expect(canHireListing(listing, "  ")).toEqual({ ok: false, reason: "unauthenticated" });
  });
});

describe("canRateListing (pur)", () => {
  it("location « completed » du locataire → ok", () => {
    expect(canRateListing({ status: "completed", tenantId: "tenant-1" }, "tenant-1")).toEqual({ ok: true });
  });

  it("location non terminée → refus", () => {
    expect(canRateListing({ status: "held", tenantId: "tenant-1" }, "tenant-1")).toEqual({ ok: false, reason: "not_completed" });
    expect(canRateListing({ status: "released", tenantId: "tenant-1" }, "tenant-1")).toEqual({ ok: false, reason: "not_completed" });
  });

  it("un autre utilisateur ne peut pas noter (reason not_tenant)", () => {
    expect(canRateListing({ status: "completed", tenantId: "tenant-1" }, "intrus-1")).toEqual({ ok: false, reason: "not_tenant" });
  });
});

describe("rateForListing (pur)", () => {
  it("aucun avis → 0", () => {
    expect(rateForListing({ stats: { hires: 3, ratingSum: 0, ratingCount: 0 } })).toBe(0);
  });

  it("moyenne arrondie à 1 décimale", () => {
    expect(rateForListing({ stats: { hires: 2, ratingSum: 9, ratingCount: 2 } })).toBe(4.5);
    expect(rateForListing({ stats: { hires: 3, ratingSum: 10, ratingCount: 3 } })).toBe(3.3);
    expect(rateForListing({ stats: { hires: 1, ratingSum: 5, ratingCount: 1 } })).toBe(5);
  });
});

describe("compareListingsForSort (pur)", () => {
  const a = listingFixture({ listingId: "a", createdAtMs: 10, stats: { hires: 1, ratingSum: 4, ratingCount: 1 }, pricing: { model: "per_mission", priceMinor: 500 } });
  const b = listingFixture({ listingId: "b", createdAtMs: 20, stats: { hires: 5, ratingSum: 10, ratingCount: 2 }, pricing: { model: "per_mission", priceMinor: 900 } });

  it("newest → le plus récent d'abord", () => {
    expect(compareListingsForSort(a, b, "newest")).toBeGreaterThan(0);
  });
  it("popular → le plus loué d'abord", () => {
    expect(compareListingsForSort(a, b, "popular")).toBeGreaterThan(0);
  });
  it("price_asc → le moins cher d'abord", () => {
    expect(compareListingsForSort(a, b, "price_asc")).toBeLessThan(0);
  });
  it("rating → meilleure moyenne d'abord", () => {
    // a = 4,0 · b = 5,0 → b doit être classée AVANT a (comparateur > 0).
    expect(compareListingsForSort(a, b, "rating")).toBeGreaterThan(0);
  });
});

describe("bornes de schéma (pur)", () => {
  it("prix : 100 minor = 1 FCFA accepté, en dessous refusé", () => {
    expect(ListingPricingSchema.safeParse({ model: "per_mission", priceMinor: 100 }).success).toBe(true);
    expect(ListingPricingSchema.safeParse({ model: "per_mission", priceMinor: 99 }).success).toBe(false);
    expect(ListingPricingSchema.safeParse({ model: "per_mission", priceMinor: 1_000_000 }).success).toBe(true);
    expect(ListingPricingSchema.safeParse({ model: "per_mission", priceMinor: 1_000_001 }).success).toBe(false);
  });

  it("note : entiers 1..5 uniquement (schéma d'avis)", () => {
    const base = { reviewId: "r", listingId: "l", hireId: "h", tenantId: "t", createdAtMs: 1 };
    expect(ListingReviewSchema.safeParse({ ...base, rating: 1 }).success).toBe(true);
    expect(ListingReviewSchema.safeParse({ ...base, rating: 5 }).success).toBe(true);
    expect(ListingReviewSchema.safeParse({ ...base, rating: 0 }).success).toBe(false);
    expect(ListingReviewSchema.safeParse({ ...base, rating: 6 }).success).toBe(false);
    expect(ListingReviewSchema.safeParse({ ...base, rating: 3.5 }).success).toBe(false);
  });
});

describe("publishAgentListing (mocks adminDb)", () => {
  const agent = { id: "a1", ownerId: "owner-1", status: "active", name: "Agent", description: "", type: "universal" };

  it("agent absent/inaccessible → 404 (anti-énumération)", async () => {
    mocks.getAgentForOwner.mockResolvedValue(null);
    await expect(
      publishAgentListing("owner-1", { agentId: "a1", title: "T", description: "D", pricing: { priceMinor: 500 } }),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.listingDoc.set).not.toHaveBeenCalled();
  });

  it("agent inactif → 409", async () => {
    mocks.getAgentForOwner.mockResolvedValue({ ...agent, status: "paused" });
    await expect(
      publishAgentListing("owner-1", { agentId: "a1", title: "T", description: "D", pricing: { priceMinor: 500 } }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("publication nominale → listing créé « published »", async () => {
    mocks.getAgentForOwner.mockResolvedValue(agent);
    const listing = await publishAgentListing("owner-1", {
      agentId: "a1",
      title: "  Agent marketing  ",
      description: "Description.",
      capabilityTags: ["seo", " ads "],
      pricing: { priceMinor: 5_000 },
    });
    expect(listing.status).toBe("published");
    expect(listing.title).toBe("Agent marketing");
    expect(listing.capabilityTags).toEqual(["seo", "ads"]);
    expect(listing.stats).toEqual({ hires: 0, ratingSum: 0, ratingCount: 0 });
    expect(mocks.listingDoc.set).toHaveBeenCalledWith(expect.objectContaining({ agentId: "a1", ownerId: "owner-1" }));
  });

  it("publish:false → brouillon « draft »", async () => {
    mocks.getAgentForOwner.mockResolvedValue(agent);
    const listing = await publishAgentListing("owner-1", {
      agentId: "a1",
      title: "T",
      description: "D",
      pricing: { priceMinor: 500 },
      publish: false,
    });
    expect(listing.status).toBe("draft");
  });

  it("UPSERT : republier un agent déjà listé MET À JOUR l'annonce (jamais de doublon)", async () => {
    mocks.getAgentForOwner.mockResolvedValue(agent);
    mocks.queryGet.mockResolvedValue({
      docs: [{ id: "l-existant", data: () => listingFixture({ listingId: "l-existant", title: "Ancien titre" }) }],
    });
    const listing = await publishAgentListing("owner-1", {
      agentId: "a1",
      title: "Nouveau titre",
      description: "Nouvelle description.",
      pricing: { priceMinor: 7_000 },
    });
    expect(listing.listingId).toBe("l-existant");
    expect(listing.title).toBe("Nouveau titre");
    expect(listing.pricing.priceMinor).toBe(7_000);
    expect(mocks.listingDoc.set).toHaveBeenCalledWith(expect.objectContaining({ listingId: "l-existant", title: "Nouveau titre" }));
  });
});

describe("updateAgentListing (mocks adminDb)", () => {
  it("annonce d'un autre propriétaire → 404 anti-énumération", async () => {
    mocks.listingDoc.get.mockResolvedValue({ exists: true, data: () => listingFixture() });
    await expect(updateAgentListing("intrus-1", "l1", { title: "Piraté" })).rejects.toMatchObject({ status: 404 });
    expect(mocks.listingDoc.set).not.toHaveBeenCalled();
  });

  it("annonce absente → 404", async () => {
    mocks.listingDoc.get.mockResolvedValue({ exists: false, data: () => undefined });
    await expect(updateAgentListing("owner-1", "l1", { title: "X" })).rejects.toMatchObject({ status: 404 });
  });

  it("mise à jour propriétaire : champs éditables fusionnés", async () => {
    mocks.listingDoc.get.mockResolvedValue({ exists: true, data: () => listingFixture() });
    const listing = await updateAgentListing("owner-1", "l1", { title: "Titre v2", status: "suspended", priceMinor: 9_900 });
    expect(listing.title).toBe("Titre v2");
    expect(listing.status).toBe("suspended");
    expect(listing.pricing).toEqual({ model: "per_mission", priceMinor: 9_900 });
    expect(listing.description).toBe("Un agent pour vos campagnes.");
    expect(mocks.listingDoc.set).toHaveBeenCalledWith(expect.objectContaining({ listingId: "l1", status: "suspended" }));
  });

  it("HttpError conservée (statut exact)", async () => {
    mocks.listingDoc.get.mockResolvedValue({ exists: false, data: () => undefined });
    const error = await updateAgentListing("owner-1", "l1", { title: "X" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
  });
});

describe("upsertListingReview (mocks adminDb)", () => {
  function inTransaction() {
    mocks.runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        get: (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (ref: { set: (...args: unknown[]) => unknown }, data: unknown, opts: unknown) => ref.set(data, opts),
      }),
    );
  }

  it("refus si la location n'est pas « completed » (403, aucune écriture)", async () => {
    mocks.hireDoc.get.mockResolvedValue({ exists: true, data: () => hireFixture({ status: "held" }) });
    await expect(upsertListingReview("tenant-1", { listingId: "l1", hireId: "h1", rating: 5 })).rejects.toMatchObject({ status: 403 });
    expect(mocks.reviewDoc.set).not.toHaveBeenCalled();
  });

  it("refus si ce n'est pas le locataire (403)", async () => {
    mocks.hireDoc.get.mockResolvedValue({ exists: true, data: () => hireFixture() });
    await expect(upsertListingReview("intrus-1", { listingId: "l1", hireId: "h1", rating: 5 })).rejects.toMatchObject({ status: 403 });
  });

  it("création d'avis : stats listing (ratingSum +4, ratingCount +1) et moyenne renvoyée", async () => {
    mocks.hireDoc.get.mockResolvedValue({ exists: true, data: () => hireFixture() });
    mocks.reviewDoc.get.mockResolvedValue({ exists: false, data: () => undefined });
    // 1re lecture : dans la transaction (stats avant avis) ; 2e : relecture
    // du listing APRÈS écriture (stats mises à jour → moyenne renvoyée).
    mocks.listingDoc.get
      .mockResolvedValueOnce({ exists: true, data: () => listingFixture({ stats: { hires: 3, ratingSum: 0, ratingCount: 0 } }) })
      .mockResolvedValueOnce({ exists: true, data: () => listingFixture({ stats: { hires: 3, ratingSum: 4, ratingCount: 1 } }) });
    inTransaction();
    const result = await upsertListingReview("tenant-1", { listingId: "l1", hireId: "h1", rating: 4, comment: " Très bien " });
    expect(result.created).toBe(true);
    expect(result.review).toMatchObject({ reviewId: "l1_h1", rating: 4, comment: "Très bien" });
    expect(mocks.reviewDoc.set).toHaveBeenCalledWith(expect.objectContaining({ reviewId: "l1_h1", rating: 4 }));
    expect(mocks.listingDoc.set).toHaveBeenCalledWith(
      expect.objectContaining({ stats: { hires: 3, ratingSum: 4, ratingCount: 1 } }),
      { merge: true },
    );
    expect(result.rating).toBe(4);
  });

  it("MISE À JOUR d'avis : ancienne note retirée, compteur inchangé", async () => {
    mocks.hireDoc.get.mockResolvedValue({ exists: true, data: () => hireFixture() });
    mocks.reviewDoc.get.mockResolvedValue({ exists: true, data: () => ({ rating: 2, createdAtMs: 111 }) });
    mocks.listingDoc.get.mockResolvedValue({
      exists: true,
      data: () => listingFixture({ stats: { hires: 3, ratingSum: 2, ratingCount: 1 } }),
    });
    inTransaction();
    const result = await upsertListingReview("tenant-1", { listingId: "l1", hireId: "h1", rating: 5 });
    expect(result.created).toBe(false);
    expect(mocks.listingDoc.set).toHaveBeenCalledWith(
      expect.objectContaining({ stats: { hires: 3, ratingSum: 5, ratingCount: 1 } }),
      { merge: true },
    );
    expect(result.review.createdAtMs).toBe(111);
  });

  it("location incohérente avec le listing → 404", async () => {
    mocks.hireDoc.get.mockResolvedValue({ exists: true, data: () => hireFixture({ listingId: "autre" }) });
    await expect(upsertListingReview("tenant-1", { listingId: "l1", hireId: "h1", rating: 5 })).rejects.toMatchObject({ status: 404 });
  });
});

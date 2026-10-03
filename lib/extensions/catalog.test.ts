import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Catalogue paginé (tri + curseur keyset déterministe) et cycle de vie des
 * avis (réponse développeur, modération admin avec stats cohérentes).
 */

let docsInCollection: Array<{ id: string; data: Record<string, unknown> }>;

const chainApi = {
  where: vi.fn(() => chainApi),
  orderBy: vi.fn(() => chainApi),
  limit: vi.fn(() => chainApi),
  get: vi.fn(async () => ({
    size: docsInCollection.length,
    docs: docsInCollection.map((doc) => ({ id: doc.id, data: () => doc.data })),
  })),
};

vi.mock("@/lib/firebase/admin", () => {
  const makeDocRef = (path: string) => ({
    __path: path,
    get: vi.fn(async () => {
      const found = docsInCollection.find((d) => path.endsWith(`/${d.id}`));
      return { exists: Boolean(found), data: () => found?.data };
    }),
    update: vi.fn(async (patch: Record<string, unknown>) => {
      const found = docsInCollection.find((d) => path.endsWith(`/${d.id}`));
      if (found) found.data = { ...found.data, ...patch };
    }),
  });
  return {
    adminDb: {
      collection: vi.fn((name: string) => ({
        doc: vi.fn((id: string) => makeDocRef(`${name}/${id}`)),
        where: chainApi.where,
        orderBy: chainApi.orderBy,
        limit: chainApi.limit,
        get: chainApi.get,
        add: vi.fn(async () => ({ id: "auto" })),
      })),
      runTransaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) =>
        fn({
          get: vi.fn(async (ref: { __path: string }) => {
            const found = docsInCollection.find((d) => ref.__path.endsWith(`/${d.id}`));
            return { exists: Boolean(found), data: () => found?.data };
          }),
          update: vi.fn((ref: { __path: string }, patch: Record<string, unknown>) => {
            const found = docsInCollection.find((d) => ref.__path.endsWith(`/${d.id}`));
            if (found) found.data = { ...found.data, ...patch };
          }),
          set: vi.fn(),
          create: vi.fn(),
        }),
      ),
    },
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  };
});

import {
  listApprovedCatalogPage,
  moderateReview,
  replyToReview,
  type ExtensionDoc,
} from "./repository";

function extensionDoc(id: string, overrides: Partial<ExtensionDoc> = {}): ExtensionDoc {
  return {
    id,
    name: id,
    description: "",
    category: "productivity",
    tags: [],
    developerId: "dev-1",
    developerName: "Dev",
    projectId: "p1",
    status: "approved",
    permissions: [],
    pricing: { model: "one_time", amountMinor: 1_000, currency: "XAF" },
    latestVersion: "1.0.0",
    approvedVersion: "1.0.0",
    stats: { installs: 0, ratingSum: 0, ratingCount: 0, executions: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as ExtensionDoc;
}

function seed(catalog: ExtensionDoc[]) {
  docsInCollection = catalog.map((doc) => ({ id: doc.id, data: doc as unknown as Record<string, unknown> }));
}

beforeEach(() => {
  docsInCollection = [];
  chainApi.where.mockClear();
  chainApi.orderBy.mockClear();
  chainApi.limit.mockClear();
});

describe("listApprovedCatalogPage", () => {
  const CATALOG = [
    extensionDoc("a", { stats: { installs: 30, ratingSum: 8, ratingCount: 2, executions: 0 }, createdAt: 10 }),
    extensionDoc("b", { stats: { installs: 50, ratingSum: 5, ratingCount: 1, executions: 0 }, createdAt: 30 }),
    extensionDoc("c", { stats: { installs: 10, ratingSum: 10, ratingCount: 2, executions: 0 }, createdAt: 20, pricing: { model: "one_time", amountMinor: 5_000, currency: "XAF" } }),
    extensionDoc("d", { stats: { installs: 50, ratingSum: 0, ratingCount: 0, executions: 0 }, createdAt: 15 }),
  ];

  it("tri popular (installs desc, départage par id) + pagination keyset", async () => {
    seed(CATALOG);
    const page1 = await listApprovedCatalogPage({ limit: 2, sort: "popular" });
    expect(page1.docs.map((d) => d.id)).toEqual(["b", "d"]); // installs 50, id asc
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await listApprovedCatalogPage({ limit: 2, sort: "popular", cursor: page1.nextCursor ?? "" });
    expect(page2.docs.map((d) => d.id)).toEqual(["a", "c"]);
    expect(page2.nextCursor).toBeNull(); // fin de catalogue
  });

  it("tris newest / price_asc / rating", async () => {
    seed(CATALOG);
    const newest = await listApprovedCatalogPage({ sort: "newest" });
    expect(newest.docs.map((d) => d.id)).toEqual(["b", "c", "d", "a"]);

    const cheapest = await listApprovedCatalogPage({ sort: "price_asc" });
    expect(cheapest.docs[0].id).toBe("a"); // 1 000 XAF (a/b/d ex æquo → id asc)
    expect(cheapest.docs.map((d) => d.id)).toEqual(["a", "b", "d", "c"]);

    const bestRated = await listApprovedCatalogPage({ sort: "rating" });
    expect(bestRated.docs[0].id).toBe("b"); // note 5.0 (b) — départage id asc
    expect(bestRated.docs[1].id).toBe("c"); // note 5.0 (c)
    expect(bestRated.docs[2].id).toBe("a"); // note 4.0
  });

  it("recherche q + catégorie + curseur invalide refusé", async () => {
    seed(CATALOG.map((doc) => ({ ...doc, tags: doc.id === "b" ? ["crm"] : [] })));
    const filtered = await listApprovedCatalogPage({ q: "CRM" });
    expect(filtered.docs.map((d) => d.id)).toEqual(["b"]);

    const byCategory = await listApprovedCatalogPage({ category: "productivity", limit: 10 });
    expect(byCategory.docs).toHaveLength(4);

    await expect(listApprovedCatalogPage({ cursor: "pas-un-curseur!!" })).rejects.toThrow("Curseur");
  });

  it("catalogue vide → page vide, pas de curseur", async () => {
    seed([]);
    const page = await listApprovedCatalogPage({});
    expect(page.docs).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
    expect(page.truncated).toBe(false);
  });
});

describe("réponses développeur + modération admin", () => {
  it("réponse développeur : autorisé pour le propriétaire, refusé pour un autre", async () => {
    docsInCollection = [
      { id: "ext-pro", data: extensionDoc("ext-pro", { developerId: "dev-1" }) as unknown as Record<string, unknown> },
      { id: "ext-pro__u1", data: { id: "ext-pro__u1", extensionId: "ext-pro", userId: "u1", rating: 5, body: "Super", status: "visible", createdAt: 1, updatedAt: 1 } },
    ];
    const replied = await replyToReview({ extensionId: "ext-pro", developerId: "dev-1", reviewId: "ext-pro__u1", reply: "Merci du retour !" });
    expect(replied.developerReply?.body).toBe("Merci du retour !");

    await expect(replyToReview({ extensionId: "ext-pro", developerId: "intru", reviewId: "ext-pro__u1", reply: "hack" }))
      .rejects.toThrow("Seul le développeur");
  });

  it("modération hide → stats décrémentées ; show sur avis caché → incrémentées ; idempotent", async () => {
    docsInCollection = [
      { id: "ext-pro", data: extensionDoc("ext-pro", { stats: { installs: 5, ratingSum: 9, ratingCount: 2, executions: 0 } }) as unknown as Record<string, unknown> },
      { id: "rev-1", data: { id: "rev-1", extensionId: "ext-pro", userId: "u1", rating: 4, body: "Bien", status: "visible", createdAt: 1, updatedAt: 1 } },
    ];

    const hidden = await moderateReview({ reviewId: "rev-1", action: "hide" });
    expect(hidden.status).toBe("hidden");

    // Re-hide → idempotent (aucun nouveau changement)
    const again = await moderateReview({ reviewId: "rev-1", action: "hide" });
    expect(again.status).toBe("hidden");

    const shown = await moderateReview({ reviewId: "rev-1", action: "show" });
    expect(shown.status).toBe("visible");
  });

  it("modération d'un avis inexistant → erreur claire", async () => {
    docsInCollection = [];
    await expect(moderateReview({ reviewId: "ghost", action: "hide" })).rejects.toThrow("Avis introuvable");
  });
});

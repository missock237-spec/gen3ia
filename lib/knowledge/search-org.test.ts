import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Recherche knowledge org-aware (recommandation C) : le filtre vectoriel
 * élargit la lecture aux orgs de l'appelant (userId OU orgId, jamais un
 * tiers) ; le repli Firestore opère une union personnel + org avec la
 * même frontière de sécurité (orgIds résolus SERVEUR uniquement).
 */

const chunkQueryWhere = vi.fn();
const personalChunkGet = vi.fn();
const orgChunkGet = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      where: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({ get: (...args: unknown[]) => chunkQueryWhere(...args) })),
        })),
        limit: vi.fn(() => ({ get: (...args: unknown[]) => chunkQueryWhere(...args) })),
      })),
    })),
  },
}));

vi.mock("@/lib/memory/embeddings", () => ({
  createMemoryEmbedding: vi.fn(async () => [0.1, 0.2]),
}));

vi.mock("@/lib/memory/similarity", () => ({
  cosineSimilarity: vi.fn((a: number[], b: number[]) => {
    if (!Array.isArray(b) || b.length === 0) return 0;
    return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0);
  }),
}));

const mockedSearchVectorPoints = vi.fn();
vi.mock("@/lib/memory/vector-store", () => ({
  VECTOR_COLLECTION_KNOWLEDGE: "knowledge_test",
  searchVectorPoints: (...args: unknown[]) => mockedSearchVectorPoints(...args),
}));

const mockedListOrgs = vi.fn();
vi.mock("@/lib/tenants/resource-access", () => ({
  listUserOrgIds: (...args: unknown[]) => mockedListOrgs(...args),
}));

import { resolveKnowledgeScope, searchKnowledge } from "./search";

beforeEach(() => {
  mockedSearchVectorPoints.mockReset();
  chunkQueryWhere.mockReset();
  personalChunkGet.mockReset();
  orgChunkGet.mockReset();
  mockedListOrgs.mockReset();
  mockedSearchVectorPoints.mockResolvedValue(null);
  chunkQueryWhere.mockResolvedValue({ docs: [] });
});

describe("resolveKnowledgeScope", () => {
  it("résout SERVEUR les orgs de l'appelant (index user→org)", async () => {
    mockedListOrgs.mockResolvedValue(["org-1", "org-2"]);
    expect(await resolveKnowledgeScope("u1")).toEqual(["org-1", "org-2"]);
    expect(mockedListOrgs).toHaveBeenCalledWith("u1");
  });
});

describe("searchKnowledge — filtre vectoriel", () => {
  it("sans orgIds : filtre userId strict (comportement historique)", async () => {
    await searchKnowledge("u1", "p1", "question");
    expect(mockedSearchVectorPoints).toHaveBeenCalledTimes(1);
    const filter = mockedSearchVectorPoints.mock.calls[0][2].filter;
    expect(filter).toEqual({ userId: "u1", projectId: "p1", orgIds: [] });
  });

  it("avec orgIds : le filtre porte le périmètre org (union côté Qdrant)", async () => {
    await searchKnowledge("u1", "p1", "question", 8, ["org-1", "org-2"]);
    const filter = mockedSearchVectorPoints.mock.calls[0][2].filter;
    expect(filter.orgIds).toEqual(["org-1", "org-2"]);
  });

  it("les hits vectoriels sont mappés sans aller-retour Firestore", async () => {
    mockedSearchVectorPoints.mockResolvedValue([
      { id: "c1", score: 0.9, payload: { documentId: "d1", text: "fragment", chunkIndex: 2 } },
    ]);
    const hits = await searchKnowledge("u1", "p1", "question");
    expect(hits).toEqual([{ id: "c1", documentId: "d1", text: "fragment", chunkIndex: 2, score: 0.9 }]);
  });
});

describe("searchKnowledge — repli Firestore en union", () => {
  function mockFallbackQueries(personal: Array<{ id: string; data: () => Record<string, unknown> }>, org: Array<{ id: string; data: () => Record<string, unknown> }>) {
    let orgCall = 0;
    chunkQueryWhere.mockImplementation(() => {
      if (orgCall++ === 0) return Promise.resolve({ docs: personal });
      return Promise.resolve({ docs: org });
    });
  }

  it("union personnel + org, dédupliquée par id, tri score desc, plafond respecté", async () => {
    mockFallbackQueries(
      [{ id: "c-perso", data: () => ({ documentId: "d1", text: "perso", chunkIndex: 0, embedding: [0.2, 0] }) }],
      [
        { id: "c-org", data: () => ({ documentId: "d2", text: "org", chunkIndex: 1, embedding: [0.1, 0.2] }) },
        { id: "c-perso", data: () => ({ documentId: "d1", text: "doublon", chunkIndex: 0, embedding: [0.5, 0] }) },
      ],
    );
    const hits = await searchKnowledge("u1", "p1", "question", 8, ["org-1"]);
    expect(hits.map((h) => h.id).sort()).toEqual(["c-org", "c-perso"]);
    expect(hits.find((h) => h.id === "c-perso")!.text).toBe("perso");
    expect(hits[0].id).toBe("c-org"); // score le plus élevé (produit scalaire positif)
  });

  it("orgIds vides : une seule requête personnelle", async () => {
    mockFallbackQueries([], []);
    await searchKnowledge("u1", "p1", "question");
    expect(chunkQueryWhere).toHaveBeenCalledTimes(1);
  });

  it("65 orgs : requêtes chunkées par 30 + la requête personnelle", async () => {
    mockFallbackQueries([], []);
    const orgs = Array.from({ length: 65 }, (_, i) => `org-${i}`);
    await searchKnowledge("u1", "p1", "question", 8, orgs);
    expect(chunkQueryWhere).toHaveBeenCalledTimes(1 + 3);
  });
});

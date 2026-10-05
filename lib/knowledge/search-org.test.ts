import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Recherche knowledge org-aware (recommandation C) : le filtre vectoriel
 * élargit la lecture aux orgs de l'appelant (userId OU orgId, jamais un
 * tiers) ; le repli Firestore opère une union personnel + org avec la
 * même frontière de sécurité (orgIds résolus SERVEUR uniquement).
 *
 * Politique de repli (économie de quota Firestore) : Qdrant qui RÉPOND
 * (même 0 hit) = résultat légitime, AUCUN repli ; repli réservé à
 * Qdrant non configuré (plafond 100 fragments au total) ou en erreur
 * (limites historiques 500 par portée).
 */

const chunkQueryWhere = vi.fn();
const chunkQueryLimits: number[] = [];
const personalChunkGet = vi.fn();
const orgChunkGet = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      where: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn((n: number) => {
            chunkQueryLimits.push(n);
            return { get: (...args: unknown[]) => chunkQueryWhere(...args) };
          }),
        })),
        limit: vi.fn((n: number) => {
          chunkQueryLimits.push(n);
          return { get: (...args: unknown[]) => chunkQueryWhere(...args) };
        }),
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
const mockedVectorConfigured = vi.fn();
vi.mock("@/lib/memory/vector-store", () => ({
  VECTOR_COLLECTION_KNOWLEDGE: "knowledge_test",
  searchVectorPoints: (...args: unknown[]) => mockedSearchVectorPoints(...args),
  isVectorStoreConfigured: (...args: unknown[]) => mockedVectorConfigured(...args),
}));

const mockedListOrgs = vi.fn();
vi.mock("@/lib/tenants/resource-access", () => ({
  listUserOrgIds: (...args: unknown[]) => mockedListOrgs(...args),
}));

import { resolveKnowledgeScope, searchKnowledge } from "./search";

beforeEach(() => {
  mockedSearchVectorPoints.mockReset();
  mockedVectorConfigured.mockReset().mockReturnValue(true); // défaut : Qdrant configuré
  chunkQueryWhere.mockReset();
  personalChunkGet.mockReset();
  orgChunkGet.mockReset();
  mockedListOrgs.mockReset();
  mockedSearchVectorPoints.mockResolvedValue(null);
  chunkQueryWhere.mockResolvedValue({ docs: [] });
  chunkQueryLimits.length = 0;
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

function mockFallbackQueries(personal: Array<{ id: string; data: () => Record<string, unknown> }>, org: Array<{ id: string; data: () => Record<string, unknown> }>) {
  let orgCall = 0;
  chunkQueryWhere.mockImplementation(() => {
    if (orgCall++ === 0) return Promise.resolve({ docs: personal });
    return Promise.resolve({ docs: org });
  });
}

describe("searchKnowledge — repli Firestore en union", () => {
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

describe("searchKnowledge — politique de repli (quota Firestore)", () => {
  it("Qdrant configuré qui répond vide (0 hit légitime) : AUCUN repli Firestore", async () => {
    mockedSearchVectorPoints.mockResolvedValue([]);
    const hits = await searchKnowledge("u1", "p1", "question");
    expect(hits).toEqual([]);
    expect(chunkQueryWhere).not.toHaveBeenCalled();
  });

  it("Qdrant non configuré : repli plafonné à 100 fragments AU TOTAL (répartis entre portées)", async () => {
    mockedVectorConfigured.mockReturnValue(false);
    mockFallbackQueries([], []);
    const orgs = Array.from({ length: 65 }, (_, i) => `org-${i}`); // 1 + 3 requêtes
    await searchKnowledge("u1", "p1", "question", 8, orgs);
    expect(mockedSearchVectorPoints).not.toHaveBeenCalled(); // pas d'appel vectoriel sans client
    expect(chunkQueryLimits).toHaveLength(4);
    const total = chunkQueryLimits.reduce((sum, n) => sum + n, 0);
    expect(total).toBeLessThanOrEqual(100);
    expect(chunkQueryLimits.every((n) => n === 25)).toBe(true); // 100 / 4 portées
  });

  it("Qdrant non configuré, sans org : une seule requête personnelle plafonnée à 100", async () => {
    mockedVectorConfigured.mockReturnValue(false);
    mockFallbackQueries([], []);
    await searchKnowledge("u1", "p1", "question");
    expect(chunkQueryLimits).toEqual([100]);
  });

  it("Qdrant en ERREUR (null) : repli conservé aux limites historiques (500 par portée)", async () => {
    mockedSearchVectorPoints.mockResolvedValue(null);
    mockFallbackQueries([], []);
    const orgs = Array.from({ length: 65 }, (_, i) => `org-${i}`);
    await searchKnowledge("u1", "p1", "question", 8, orgs);
    expect(mockedSearchVectorPoints).toHaveBeenCalledTimes(1);
    expect(chunkQueryLimits).toHaveLength(4);
    expect(chunkQueryLimits.every((n) => n === 500)).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests du vector store Qdrant :
 *  - sans configuration : fonctions fail-soft (null/false, zéro exception) ;
 *  - avec client simulé : normalisation collectionExists, index de payload,
 *    filtre multi-tenant obligatoire, mapping des hits.
 */

const mockedQdrantInstance = {
  collectionExists: vi.fn(),
  createCollection: vi.fn(),
  createPayloadIndex: vi.fn(),
  upsert: vi.fn(),
  query: vi.fn(),
  delete: vi.fn(),
  getCollection: vi.fn(),
};

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: vi.fn(function QdrantClient() {
    return mockedQdrantInstance;
  }),
}));

import {
  ensureVectorCollection,
  isVectorStoreConfigured,
  resetVectorClientForTests,
  searchVectorPoints,
  upsertVectorPoints,
} from "./vector-store";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.QDRANT_URL;
  delete process.env.QDRANT_API_KEY;
  resetVectorClientForTests();
});

function activerQdrantSimule(): void {
  process.env.QDRANT_URL = "https://qdrant-simule.test.io";
  process.env.QDRANT_API_KEY = "cle-de-test";
  resetVectorClientForTests();
}

describe("vector store — repli sans configuration", () => {
  it("isVectorStoreConfigured retourne false sans variables", () => {
    expect(isVectorStoreConfigured()).toBe(false);
  });

  it("ensureVectorCollection échoue proprement (false)", async () => {
    await expect(ensureVectorCollection("col")).resolves.toBe(false);
  });

  it("upsertVectorPoints retourne false sans lever d'exception", async () => {
    await expect(
      upsertVectorPoints("col", [{ id: "a", vector: [0.1, 0.2], payload: {} }]),
    ).resolves.toBe(false);
  });

  it("searchVectorPoints retourne null (le caller basculera sur Firestore)", async () => {
    await expect(
      searchVectorPoints("col", [0.1, 0.2], { limit: 5, filter: { userId: "u1" } }),
    ).resolves.toBeNull();
  });

  it("upsertVectorPoints refuse une liste vide", async () => {
    activerQdrantSimule();
    await expect(upsertVectorPoints("col", [])).resolves.toBe(false);
  });
});

describe("vector store — avec Qdrant", () => {
  it("crée la collection + les index de payload si absente (normalisation {exists})", async () => {
    activerQdrantSimule();
    mockedQdrantInstance.collectionExists.mockResolvedValue({ exists: false });
    mockedQdrantInstance.createCollection.mockResolvedValue(true);
    mockedQdrantInstance.createPayloadIndex.mockResolvedValue(true);

    await expect(ensureVectorCollection("col", 384)).resolves.toBe(true);
    expect(mockedQdrantInstance.createCollection).toHaveBeenCalledWith("col", {
      vectors: { size: 384, distance: "Cosine" },
    });
    // userId, projectId, agentId, documentId — index multi-tenant obligatoires.
    expect(mockedQdrantInstance.createPayloadIndex).toHaveBeenCalledTimes(4);
    expect(mockedQdrantInstance.createPayloadIndex).toHaveBeenCalledWith("col", {
      field_name: "userId",
      field_schema: "keyword",
      wait: true,
    });
  });

  it("gère la forme booléenne de collectionExists (compatibilité versions)", async () => {
    activerQdrantSimule();
    mockedQdrantInstance.collectionExists.mockResolvedValue(true);
    mockedQdrantInstance.createPayloadIndex.mockResolvedValue(true);

    await expect(ensureVectorCollection("col", 384)).resolves.toBe(true);
    expect(mockedQdrantInstance.createCollection).not.toHaveBeenCalled();
  });

  it("upsert pointe vers une collection préparée avec wait:true", async () => {
    activerQdrantSimule();
    mockedQdrantInstance.collectionExists.mockResolvedValue({ exists: true });
    mockedQdrantInstance.createPayloadIndex.mockResolvedValue(true);
    mockedQdrantInstance.upsert.mockResolvedValue({ status: "completed" });

    const ok = await upsertVectorPoints("col", [
      { id: "m1", vector: [0.5, 0.5], payload: { userId: "u1" } },
    ]);
    expect(ok).toBe(true);
    expect(mockedQdrantInstance.upsert).toHaveBeenCalledWith("col", {
      wait: true,
      points: [{ id: "m1", vector: [0.5, 0.5], payload: { userId: "u1" } }],
    });
  });

  it("recherche : filtre userId obligatoire + mapping des hits", async () => {
    activerQdrantSimule();
    mockedQdrantInstance.collectionExists.mockResolvedValue({ exists: true });
    mockedQdrantInstance.createPayloadIndex.mockResolvedValue(true);
    mockedQdrantInstance.query.mockResolvedValue({
      points: [
        { id: "m1", score: 0.93, payload: { userId: "u1", preview: "Salut" } },
        { id: "m2", score: 0.71, payload: { userId: "u1", preview: "Bonjour" } },
      ],
    });

    const hits = await searchVectorPoints("col", [0.4, 0.4], {
      limit: 2,
      filter: { userId: "u1", projectId: "p1" },
    });

    expect(hits).toHaveLength(2);
    expect(hits![0]).toEqual({ id: "m1", score: 0.93, payload: { userId: "u1", preview: "Salut" } });
    const filter = mockedQdrantInstance.query.mock.calls[0][1].filter;
    expect(filter.must).toEqual([
      { key: "userId", match: { value: "u1" } },
      { key: "projectId", match: { value: "p1" } },
    ]);
  });

  it("recherche : erreur réseau → null (repli Firestore)", async () => {
    activerQdrantSimule();
    mockedQdrantInstance.collectionExists.mockResolvedValue({ exists: true });
    mockedQdrantInstance.createPayloadIndex.mockResolvedValue(true);
    mockedQdrantInstance.query.mockRejectedValue(new Error("timeout"));

    await expect(
      searchVectorPoints("col", [0.4], { limit: 2, filter: { userId: "u1" } }),
    ).resolves.toBeNull();
  });

  it("limite de recherche bornée à 100", async () => {
    activerQdrantSimule();
    mockedQdrantInstance.collectionExists.mockResolvedValue({ exists: true });
    mockedQdrantInstance.createPayloadIndex.mockResolvedValue(true);
    mockedQdrantInstance.query.mockResolvedValue({ points: [] });

    await searchVectorPoints("col", [0.4], { limit: 5000, filter: { userId: "u1" } });
    expect(mockedQdrantInstance.query.mock.calls[0][1].limit).toBe(100);
  });
});

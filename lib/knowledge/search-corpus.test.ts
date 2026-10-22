import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Fusion corpus global dans searchKnowledge : les fragments du corpus de
 * scraping (userId gen3ia-corpus) concourent avec les résultats
 * personnels/org — dédupliqués, triés par score, plafonnés — et la
 * recherche utilisateur ne peut JAMAIS échouer à cause du corpus
 * (fail-soft total, kill-switch PIPELINE_CORPUS_OFF).
 */

const mockedSearchVectorPoints = vi.fn();
const mockedVectorConfigured = vi.fn();
vi.mock("@/lib/memory/vector-store", () => ({
  VECTOR_COLLECTION_KNOWLEDGE: "knowledge_test",
  searchVectorPoints: (...args: unknown[]) => mockedSearchVectorPoints(...args),
  isVectorStoreConfigured: (...args: unknown[]) => mockedVectorConfigured(...args),
}));

vi.mock("@/lib/memory/embeddings", () => ({
  createMemoryEmbedding: vi.fn(async () => [0.1, 0.2]),
}));

vi.mock("@/lib/memory/similarity", () => ({
  cosineSimilarity: vi.fn(() => 0.9),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => {
      throw new Error("Firestore ne doit PAS être atteint sur le chemin Qdrant");
    }),
  },
}));

const mockedDynamicImport = vi.fn();
vi.mock("@/lib/tenants/resource-access", () => ({
  listUserOrgIds: (...args: unknown[]) => mockedDynamicImport(...args),
}));

function hit(id: string, score: number, texte: string) {
  return {
    id,
    score,
    payload: { documentId: `doc-${id}`, text: texte, chunkIndex: 0 },
  };
}

function hitQdrantBrut(id: string, score: number, texte: string) {
  return hit(id, score, texte);
}

describe("searchKnowledge — fusion corpus global", () => {
  afterEach(() => {
    delete process.env.PIPELINE_CORPUS_OFF;
    vi.clearAllMocks();
  });

  async function search(limit = 4) {
    const { searchKnowledge } = await import("./search");
    return searchKnowledge("user-1", "project-1", "question test", limit, []);
  }

  it("fusionne les fragments corpus, triés par score, plafonnés à la limite", async () => {
    mockedVectorConfigured.mockReturnValue(true);
    mockedSearchVectorPoints
      .mockResolvedValueOnce([hit("u1", 0.5, "perso"), hit("u2", 0.4, "perso2")])
      .mockResolvedValueOnce([hit("c1", 0.8, "corpus fort"), hit("c2", 0.3, "corpus faible")]);

    const resultats = await search(4);
    expect(resultats.map((r) => r.id)).toEqual(["c1", "u1", "u2", "c2"]);
    // Deuxième appel = corpus global avec le filtre userId dédié.
    const filtreCorpus = mockedSearchVectorPoints.mock.calls[1][2].filter;
    expect(filtreCorpus.userId).toBe("gen3ia-corpus");
  });

  it("déduplique par id Qdrant et conserve l'ordre par score", async () => {
    mockedVectorConfigured.mockReturnValue(true);
    mockedSearchVectorPoints
      .mockResolvedValueOnce([hit("u1", 0.7, "perso")])
      .mockResolvedValueOnce([hit("u1", 0.9, "corpus même id"), hit("c1", 0.6, "corpus")]);

    const resultats = await search(4);
    expect(resultats.map((r) => r.id)).toEqual(["u1", "c1"]);
    // Le hit utilisateur est conservé (pas de doublon corpus).
    expect(resultats[0].text).toBe("perso");
  });

  it("kill-switch PIPELINE_CORPUS_OFF : un seul appel vectoriel", async () => {
    process.env.PIPELINE_CORPUS_OFF = "1";
    mockedVectorConfigured.mockReturnValue(true);
    mockedSearchVectorPoints.mockResolvedValueOnce([hit("u1", 0.5, "perso")]);

    const resultats = await search(4);
    expect(resultats.map((r) => r.id)).toEqual(["u1"]);
    expect(mockedSearchVectorPoints).toHaveBeenCalledTimes(1);
  });

  it("fail-soft : une erreur corpus est silencieusement ignorée", async () => {
    mockedVectorConfigured.mockReturnValue(true);
    mockedSearchVectorPoints
      .mockResolvedValueOnce([hit("u1", 0.5, "perso")])
      .mockRejectedValueOnce(new Error("qdrant corpus down"));

    const resultats = await search(4);
    expect(resultats.map((r) => r.id)).toEqual(["u1"]);
  });

  it("0 hit corpus = résultats utilisateur inchangés", async () => {
    mockedVectorConfigured.mockReturnValue(true);
    mockedSearchVectorPoints
      .mockResolvedValueOnce([hit("u1", 0.5, "perso")])
      .mockResolvedValueOnce([]);

    const resultats = await search(4);
    expect(resultats.map((r) => r.id)).toEqual(["u1"]);
  });

  it("les hits corpus exposent documentId/texte/chunkIndex normalisés", async () => {
    mockedVectorConfigured.mockReturnValue(true);
    mockedSearchVectorPoints
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([hitQdrantBrut("c9", 0.55, "fragment corpus")]);

    const resultats = await search(4);
    expect(resultats[0]).toMatchObject({
      id: "c9",
      documentId: "doc-c9",
      text: "fragment corpus",
      chunkIndex: 0,
      score: 0.55,
    });
  });
});

describe("isCorpusEnabled", () => {
  it("active par défaut, désactivable par 1 ou true", async () => {
    const { isCorpusEnabled } = await import("./search");
    expect(isCorpusEnabled()).toBe(true);
    process.env.PIPELINE_CORPUS_OFF = "true";
    expect(isCorpusEnabled()).toBe(false);
    process.env.PIPELINE_CORPUS_OFF = "1";
    expect(isCorpusEnabled()).toBe(false);
    delete process.env.PIPELINE_CORPUS_OFF;
    expect(isCorpusEnabled()).toBe(true);
  });
});

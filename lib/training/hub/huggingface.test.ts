import { afterEach, describe, expect, it, vi } from "vitest";

import { huggingFaceFileUrl, inspectHuggingFaceDataset, searchHuggingFaceDatasets } from "./huggingface";
import { HubError, hubErrorStatus } from "./common";

/* ------------------------------------------------------------------ */
/* Connecteur Hugging Face — normalisation des réponses API (mock).    */
/* ------------------------------------------------------------------ */

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.HF_TOKEN;
  delete process.env.HUGGINGFACE_TOKEN;
});

describe("searchHuggingFaceDatasets", () => {
  it("normalise les résultats de l'API et la licence depuis les tags", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          id: "ucirvine/sms-spam-collection",
          likes: 250,
          downloads: 12000,
          lastModified: "2026-01-02T03:04:05Z",
          tags: ["license:cc0-1.0", "task-categories:text-classification", "language:fr"],
          private: false,
        },
        { id: "private/secret", private: true },
        { id: "noid" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchHuggingFaceDatasets("spam", 10);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      provider: "huggingface",
      ref: "ucirvine/sms-spam-collection",
      name: "sms-spam-collection",
      downloads: 12000,
      likes: 250,
      license: "cc0-1.0",
      sizeBytes: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("huggingface.co/api/datasets?search=spam"),
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("envoie le jeton HF quand il est configuré", async () => {
    process.env.HF_TOKEN = "hf_test";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await searchHuggingFaceDatasets("spam", 5);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer hf_test" }) }),
    );
  });
});

describe("inspectHuggingFaceDataset", () => {
  it("expose fichiers, splits déclarés et échantillon réel de datasets-server", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/datasets/")) {
        return Promise.resolve(
          jsonResponse({
            id: "org/jeu",
            likes: 10,
            downloads: 100,
            lastModified: "2026-02-03T00:00:00Z",
            tags: ["license:mit", "size_categories:10K<n<100K"],
            siblings: [{ rfilename: "train.csv" }, { rfilename: "README.md" }, { rfilename: ".gitattributes" }],
            cardData: { license: "mit" },
          }),
        );
      }
      if (url.includes("datasets-server.huggingface.co/info")) {
        return Promise.resolve(
          jsonResponse({
            dataset_info: {
              configs: [
                {
                  config_name: "default",
                  splits: [{ name: "train", num_examples: 8_500 }],
                  features: { instruction: { dtype: "string" }, response: { dtype: "string" } },
                },
              ],
            },
          }),
        );
      }
      if (url.includes("/first-rows")) {
        return Promise.resolve(
          jsonResponse({
            features: [{ name: "instruction" }, { name: "response" }],
            rows: [
              { row: { instruction: "Qui es-tu ?", response: "Un assistant." } },
              { row: { instruction: "Que sais-tu ?", response: "Beaucoup de choses." } },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);

    const detail = await inspectHuggingFaceDataset("org/jeu");
    expect(detail.splits).toEqual([{ name: "train", rows: 8500 }]);
    expect(detail.license).toBe("mit");
    expect(detail.files.map((f) => f.name)).toEqual(["train.csv", "README.md"]);
    expect(detail.files.find((f) => f.name === "train.csv")?.downloadable).toBe(true);
    expect(detail.files.find((f) => f.name === "README.md")?.downloadable).toBe(false);
    expect(detail.previewRows).toEqual([
      { instruction: "Qui es-tu ?", response: "Un assistant." },
      { instruction: "Que sais-tu ?", response: "Beaucoup de choses." },
    ]);
    // Note honnête : la taille des fichiers n'est pas exposée par l'API.
    expect(detail.notes.some((note) => /taille exacte des fichiers/i.test(note))).toBe(true);
  });

  it("découvre les fichiers PARQUET du dépôt via l'API tree (data/train-*.parquet, tailles réelles)", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/tree/")) {
        return Promise.resolve(
          jsonResponse([
            { type: "directory", path: "data", size: 0 },
            { type: "file", path: "data/train-00000-of-00001-9e5f6b98c6d89c9a.parquet", size: 2_500_000 },
            { type: "file", path: "README.md", size: 400 },
          ]),
        );
      }
      if (url.includes("/api/datasets/")) {
        return Promise.resolve(
          jsonResponse({
            id: "org/parquet",
            siblings: [
              { rfilename: "data/train-00000-of-00001-9e5f6b98c6d89c9a.parquet" },
              { rfilename: "README.md" },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse({ error: "not found" }, 404));
    });
    vi.stubGlobal("fetch", fetchMock);

    const detail = await inspectHuggingFaceDataset("org/parquet");
    // Le fichier data/train-*.parquet est découvert, ingérable, avec sa taille.
    const parquet = detail.files.find((f) => f.name === "data/train-00000-of-00001-9e5f6b98c6d89c9a.parquet");
    expect(parquet?.downloadable).toBe(true);
    expect(parquet?.sizeBytes).toBe(2_500_000);
    expect(detail.files.find((f) => f.name === "README.md")?.downloadable).toBe(false);
    // Note honnête : les tailles proviennent de l'API tree.
    expect(detail.notes.some((note) => /API tree/i.test(note))).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/tree/main?recursive=true"),
      expect.anything(),
    );
  });

  it("dégrade proprement quand datasets-server ne connaît pas le dépôt", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/datasets/")) {
        return Promise.resolve(
          jsonResponse({ id: "org/prive", siblings: [{ rfilename: "data.csv" }] }),
        );
      }
      return Promise.resolve(jsonResponse({ error: "not found" }, 404));
    });
    vi.stubGlobal("fetch", fetchMock);

    const detail = await inspectHuggingFaceDataset("org/prive");
    expect(detail.splits).toEqual([]);
    expect(detail.previewRows).toEqual([]);
    expect(detail.notes.some((note) => /datasets-server/i.test(note))).toBe(true);
  });

  it("remonte 404 en not-found quand le dépôt est inconnu", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("gone", { status: 404 })),
    );
    const error = await inspectHuggingFaceDataset("org/absent").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubError);
    expect(hubErrorStatus(error)).toBe(404);
  });
});

describe("huggingFaceFileUrl", () => {
  it("construit l'URL de résolution en encodant chaque segment", () => {
    expect(huggingFaceFileUrl("org/jeu", "data/train.csv")).toBe(
      "https://huggingface.co/datasets/org/jeu/resolve/main/data/train.csv",
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadKaggleFile, inspectKaggleDataset, kaggleToken, searchKaggleDatasets } from "./kaggle";
import { HubError, hubErrorStatus } from "./common";

/* ------------------------------------------------------------------ */
/* Connecteur Kaggle — jeton, normalisation, aperçu (fetch mocké).     */
/* ------------------------------------------------------------------ */

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  process.env.KAGGLE_API_TOKEN = "KGAT_test_token";
});

afterEach(() => {
  delete process.env.KAGGLE_API_TOKEN;
  delete process.env.KAGGLE_KEY;
  vi.unstubAllGlobals();
});

describe("kaggleToken", () => {
  it("signale honnêtement l'absence de jeton (aucun appel réseau)", async () => {
    delete process.env.KAGGLE_API_TOKEN;
    expect(kaggleToken()).toBeNull();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchKaggleDatasets("x", 5)).rejects.toThrow(/KAGGLE_API_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("searchKaggleDatasets", () => {
  it("normalise les résultats de l'API v1 avec champs défensifs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          ref: "uciml/sms-spam-collection-dataset",
          title: "SMS Spam Collection",
          subtitle: "Le jeu classique de détection de spam SMS",
          totalBytes: 490_000,
          licenseName: "CC0: Public Domain",
          voteCount: 1200,
          downloadCount: 95_000,
          lastUpdated: "2026-03-04",
        },
        { title: "Sans référence — ignoré" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchKaggleDatasets("spam", 10);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      provider: "kaggle",
      ref: "uciml/sms-spam-collection-dataset",
      name: "SMS Spam Collection",
      sizeBytes: 490_000,
      likes: 1200,
      downloads: 95_000,
      license: "CC0: Public Domain",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("kaggle.com/api/v1/datasets/list?search=spam"),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer KGAT_test_token" }) }),
    );
  });

  it("remonte 401 en erreur config lisible (jeton invalide)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    const error = await searchKaggleDatasets("spam", 5).catch((e: unknown) => e);
    expect(hubErrorStatus(error)).toBe(503);
    expect((error as Error).message).toMatch(/jeton d'accès/i);
  });
});

describe("inspectKaggleDataset", () => {
  it("liste les fichiers avec tailles et produit un aperçu du plus petit CSV", async () => {
    const csvContent = "instruction,response\nQ1,A1\nQ2,A2\nQ3,A3";
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/datasets/view/")) {
        return Promise.resolve(
          jsonResponse({
            ref: "owner/jeu",
            title: "Jeu de test",
            subtitle: "Sous-titre",
            licenseName: "MIT",
            totalBytes: 1_200,
          }),
        );
      }
      if (url.includes("/datasets/list/")) {
        return Promise.resolve(
          jsonResponse([
            { name: "train.csv", totalBytes: 600 },
            { name: "notes.parquet", totalBytes: 100 },
            { name: "big.parquet", totalBytes: 500 },
          ]),
        );
      }
      if (url.includes("/datasets/download/")) {
        return Promise.resolve(
          new Response(csvContent, {
            status: 200,
            headers: { "content-type": "text/csv", "content-length": String(csvContent.length) },
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);

    const detail = await inspectKaggleDataset("owner/jeu");
    expect(detail.name).toBe("Jeu de test");
    expect(detail.license).toBe("MIT");
    expect(detail.files.map((f) => f.name)).toEqual(["train.csv", "notes.parquet", "big.parquet"]);
    expect(detail.files.find((f) => f.name === "big.parquet")?.downloadable).toBe(false);
    // L'aperçu vient du fichier CSV téléchargé (le seul ingérable ≤ 2 Mo).
    expect(detail.previewRows).toHaveLength(3);
    expect(detail.previewRows[0]).toEqual({ instruction: "Q1", response: "A1" });
    expect(detail.splits).toEqual([]);
    expect(detail.notes.some((note) => /n'expose pas les splits/i.test(note))).toBe(true);
  });

  it("signale l'absence d'aperçu quand aucun fichier léger n'est ingérable", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/datasets/view/")) {
        return Promise.resolve(jsonResponse({ ref: "owner/lourd", title: "Lourd" }));
      }
      if (url.includes("/datasets/list/")) {
        return Promise.resolve(jsonResponse([{ name: "huge.csv", totalBytes: 9_000_000 }]));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);

    const detail = await inspectKaggleDataset("owner/lourd");
    expect(detail.previewRows).toEqual([]);
    expect(detail.notes.some((note) => /aucun fichier léger ingérable/i.test(note))).toBe(true);
  });
});

describe("downloadKaggleFile", () => {
  it("construit l'URL de téléchargement par fichier avec jeton Bearer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2]), {
        status: 200,
        headers: { "content-type": "text/csv", "content-length": "2" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadKaggleFile("owner/jeu", "train.csv", 1000);
    expect(result.buffer.byteLength).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.kaggle.com/api/v1/datasets/download/owner/jeu/train.csv",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer KGAT_test_token" }) }),
    );
  });

  it("refuse un nom de fichier traversant", async () => {
    await expect(downloadKaggleFile("owner/jeu", "../secret.csv", 1000)).rejects.toBeInstanceOf(HubError);
  });
});

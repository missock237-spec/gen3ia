import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertHubFileName,
  assertHubQuery,
  assertHubRef,
  csvPreviewToRows,
  hubDownloadFile,
  hubErrorStatus,
  HubError,
  hubFetchJson,
  HUB_DATASET_FILE_RE,
  parseCsvLine,
  parseCsvPreview,
  selectFilesForImport,
  truncatePreviewRows,
  type HubDatasetDetail,
} from "./common";

/* ------------------------------------------------------------------ */
/* Socle des connecteurs de hubs — validation, aperçu CSV, sélection.   */
/* ------------------------------------------------------------------ */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("assertHubRef", () => {
  it("accepte une référence propriétaire/jeu bien formée", () => {
    expect(assertHubRef("huggingface", "org/dataset")).toBe("org/dataset");
    expect(assertHubRef("kaggle", "owner/slug-2026")).toBe("owner/slug-2026");
  });

  it("refuse les références malformées (anti-SSRF / traversée)", () => {
    expect(() => assertHubRef("huggingface", "sans-slash")).toThrow(HubError);
    expect(() => assertHubRef("kaggle", "../../etc/passwd")).toThrow(HubError);
    expect(() => assertHubRef("huggingface", "a/b/c")).toThrow(HubError);
    expect(() => assertHubRef("kaggle", "/lead/slash")).toThrow(HubError);
    expect(() => assertHubRef("huggingface", "")).toThrow(HubError);
  });
});

describe("assertHubQuery", () => {
  it("trim et accepte une requête normale", () => {
    expect(assertHubQuery("  titanic  ")).toBe("titanic");
  });

  it("refuse vide, trop long, caractères de contrôle", () => {
    expect(() => assertHubQuery("   ")).toThrow(HubError);
    expect(() => assertHubQuery("x".repeat(81))).toThrow(HubError);
    expect(() => assertHubQuery("a\u0000b")).toThrow(HubError);
  });
});

describe("assertHubFileName", () => {
  it("refuse la traversée et les noms vides", () => {
    expect(() => assertHubFileName("../escape.csv")).toThrow(HubError);
    expect(() => assertHubFileName("/absolu.csv")).toThrow(HubError);
    expect(() => assertHubFileName("")).toThrow(HubError);
  });

  it("accepte un chemin relatif simple", () => {
    expect(assertHubFileName("data/train.csv")).toBe("data/train.csv");
  });
});

describe("parseCsvLine / parseCsvPreview", () => {
  it("parse les guillemets doubles échappés", () => {
    expect(parseCsvLine('"a,b",c', ",")).toEqual(["a,b", "c"]);
    expect(parseCsvLine('"He said ""hi""",x', ",")).toEqual(['He said "hi"', "x"]);
  });

  it("détecte le délimiteur point-virgule et borne lignes/colonnes", () => {
    const text = "a;b;c\n1;2;3\n4;5;6\n7;8;9";
    const preview = parseCsvPreview(text, 2, 2);
    expect(preview.header).toEqual(["a", "b"]);
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0]).toEqual(["1", "2"]);
  });

  it("retourne un aperçu vide pour un texte vide", () => {
    expect(parseCsvPreview("  \n  \n")).toEqual({ header: [], rows: [] });
  });

  it("convertit un aperçu en lignes-objets", () => {
    const rows = csvPreviewToRows({ header: ["q", "r"], rows: [["1", "2"], ["3", ""]] });
    expect(rows).toEqual([
      { q: "1", r: "2" },
      { q: "3", r: "" },
    ]);
  });
});

describe("truncatePreviewRows", () => {
  it("tronque les cellules longues et borne le nombre de lignes", () => {
    const rows = [
      { text: "x".repeat(500) },
      { text: "court" },
      { text: "autre" },
    ];
    const truncated = truncatePreviewRows(rows, 2);
    expect(truncated).toHaveLength(2);
    expect((truncated[0].text as string).length).toBe(200);
    expect(truncated[1].text).toBe("court");
  });

  it("sérialise les objets imbriqués de façon bornée", () => {
    const truncated = truncatePreviewRows([{ nested: { deep: "valeur" } }]);
    expect(truncated[0].nested).toBe(JSON.stringify({ deep: "valeur" }));
  });
});

describe("hubFetchJson", () => {
  it("retourne le JSON d'une réponse 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    await expect(hubFetchJson<{ ok: boolean }>("https://hub.example/api", {})).resolves.toEqual({ ok: true });
  });

  it("classifie 404 en not-found (statut HTTP 404)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404 })));
    const error = await hubFetchJson("https://hub.example/api", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubError);
    expect(hubErrorStatus(error)).toBe(404);
  });

  it("classifie 401/403 en config (503)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 403 })));
    const error = await hubFetchJson("https://hub.example/api", {}).catch((e: unknown) => e);
    expect(hubErrorStatus(error)).toBe(503);
  });

  it("classifie une réponse non-JSON en upstream (502)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>paille</html>", { status: 200 })),
    );
    const error = await hubFetchJson("https://hub.example/api", {}).catch((e: unknown) => e);
    expect(hubErrorStatus(error)).toBe(502);
  });
});

describe("hubDownloadFile", () => {
  it("refuse un fichier dépassant le plafond (content-length annoncé)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-length": "104857600" },
        }),
      ),
    );
    const error = await hubDownloadFile("https://hub.example/file", {}, 1000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubError);
    expect(hubErrorStatus(error)).toBe(400);
  });

  it("retourne le buffer téléchargé sous plafond", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "text/csv", "content-length": "4" },
        }),
      ),
    );
    const result = await hubDownloadFile("https://hub.example/file", {}, 1000);
    expect(result.buffer.byteLength).toBe(4);
    expect(result.contentType).toBe("text/csv");
  });
});

describe("HUB_DATASET_FILE_RE", () => {
  it("accepte les extensions ingérables, y compris .parquet (et .gz)", () => {
    expect(HUB_DATASET_FILE_RE.test("data/train-00000-of-00001-abc123.parquet")).toBe(true);
    expect(HUB_DATASET_FILE_RE.test("train.jsonl.gz")).toBe(true);
    expect(HUB_DATASET_FILE_RE.test("train.csv.gz")).toBe(true);
    expect(HUB_DATASET_FILE_RE.test("README.md")).toBe(false);
    expect(HUB_DATASET_FILE_RE.test("fichier.xlsx")).toBe(false);
  });
});

describe("selectFilesForImport", () => {
  const detail = (files: HubDatasetDetail["files"]): Pick<HubDatasetDetail, "files"> => ({ files });

  it("sélectionne les fichiers ingérables dans les plafonds", () => {
    const selection = selectFilesForImport(
      detail([
        { name: "train.csv", sizeBytes: 1000, downloadable: true },
        { name: "README.md", sizeBytes: 50, downloadable: false },
        { name: "huge.json", sizeBytes: 100_000, downloadable: true },
      ]),
      { perFileBytes: 10_000, totalBytes: 1500, maxFiles: 10 },
    );
    expect(selection.selected.map((f) => f.name)).toEqual(["train.csv"]);
    expect(selection.skipped.some((s) => s.name === "README.md" && /non ingérable/i.test(s.reason))).toBe(true);
    expect(selection.skipped.some((s) => s.name === "huge.json" && /volumineux/i.test(s.reason))).toBe(true);
  });

  it("applique le plafond total avec des raisons explicites", () => {
    const selection = selectFilesForImport(
      detail([
        { name: "a.csv", sizeBytes: 600, downloadable: true },
        { name: "b.csv", sizeBytes: 600, downloadable: true },
      ]),
      { perFileBytes: 10_000, totalBytes: 1000, maxFiles: 10 },
    );
    expect(selection.selected).toHaveLength(1);
    expect(selection.skipped.some((s) => s.name === "b.csv" && /plafond total/i.test(s.reason))).toBe(true);
  });

  it("borne le nombre de fichiers par import", () => {
    const selection = selectFilesForImport(
      detail([
        { name: "a.csv", sizeBytes: 1, downloadable: true },
        { name: "b.csv", sizeBytes: 1, downloadable: true },
        { name: "c.csv", sizeBytes: 1, downloadable: true },
      ]),
      { perFileBytes: 100, totalBytes: 100, maxFiles: 2 },
    );
    expect(selection.selected).toHaveLength(2);
    expect(selection.skipped.some((s) => /Nombre maximal de fichiers/i.test(s.reason))).toBe(true);
  });

  it("inclut les fichiers de taille inconnue (plafond au téléchargement)", () => {
    const selection = selectFilesForImport(
      detail([{ name: "data.csv", sizeBytes: 0, downloadable: true }]),
      { perFileBytes: 100, totalBytes: 100, maxFiles: 5 },
    );
    expect(selection.selected.map((f) => f.name)).toEqual(["data.csv"]);
  });

  it("filtre sur une sélection explicite demandée", () => {
    const selection = selectFilesForImport(
      detail([
        { name: "train.csv", sizeBytes: 10, downloadable: true },
        { name: "test.csv", sizeBytes: 10, downloadable: true },
      ]),
      { perFileBytes: 100, totalBytes: 100, maxFiles: 5 },
      // "absent.csv" n'existe PAS dans les fichiers du hub → raison dédiée.
      ["train.csv", "absent.csv"],
    );
    expect(selection.selected.map((f) => f.name)).toEqual(["train.csv"]);
    expect(selection.skipped.some((s) => s.name === "test.csv")).toBe(false);
    expect(selection.skipped.some((s) => s.name === "absent.csv" && /absent de ce jeu/i.test(s.reason))).toBe(true);
  });

  it("sélectionne les fichiers PARQUET (format majoritaire HF) et signale les autres", () => {
    const selection = selectFilesForImport(
      detail([
        { name: "data/train-00000-of-00001-9e5f6b98c6d89c9a.parquet", sizeBytes: 0, downloadable: true },
        { name: "README.md", sizeBytes: 50, downloadable: false },
      ]),
      { perFileBytes: 10_000, totalBytes: 10_000, maxFiles: 5 },
    );
    expect(selection.selected.map((f) => f.name)).toEqual(["data/train-00000-of-00001-9e5f6b98c6d89c9a.parquet"]);
    // Message mis à jour : le parquet fait désormais partie des formats analysés.
    expect(selection.skipped[0]?.reason).toContain(".parquet");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/* ------------------------------------------------------------------ */
/* Contrat d'API de l'import hub (v1.1) — 401/400/404/201/422,          */
/* validation RÉELLE du contenu téléchargisé, quotas, audit.            */
/* ------------------------------------------------------------------ */

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/cache/redis", () => ({
  rateLimitDistributed: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
}));
vi.mock("@/lib/storage/r2", () => ({ putObject: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/training/repository", () => ({
  getProject: vi.fn(),
  listDatasets: vi.fn().mockResolvedValue([]),
  saveDataset: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/training/quotas", () => ({
  assertAssetQuota: vi.fn().mockResolvedValue(undefined),
  assertStorageQuota: vi.fn().mockResolvedValue(undefined),
  assertUploadSize: vi.fn(),
  trainingQuotas: vi.fn(() => ({
    maxProjects: 10,
    maxConcurrentJobs: 1,
    maxUploadBytes: 200 * 1024 * 1024,
    maxDatasetsPerProject: 50,
    maxModelsPerProject: 20,
    maxStorageBytes: 2048 * 1024 * 1024,
    maxTrainingMinutesPerMonth: 60,
    maxHubImportBytes: 500 * 1024 * 1024,
  })),
}));
vi.mock("@/lib/training/audit", () => ({
  recordTrainingAudit: vi.fn().mockResolvedValue(undefined),
  ipFromRequest: vi.fn(() => "203.0.113.9"),
}));
// Le connecteur hub est mocké, SAUF la sélection de fichiers dont
// l'implémentation RÉELLE (pure) est réutilisée depuis common.
vi.mock("@/lib/training/hub", async () => {
  const common = await import("@/lib/training/hub/common");
  return {
    inspectHubDataset: vi.fn(),
    downloadHubFile: vi.fn(),
    selectFilesForImport: common.selectFilesForImport,
    HubError: common.HubError,
    hubErrorStatus: common.hubErrorStatus,
  };
});

import { requireUser } from "@/lib/security/authenticated-request";
import { unauthorized } from "@/lib/security/http-errors";
import { getProject, saveDataset } from "@/lib/training/repository";
import { recordTrainingAudit } from "@/lib/training/audit";
import { downloadHubFile, inspectHubDataset } from "@/lib/training/hub";

import { POST } from "./route";

const mockedRequireUser = vi.mocked(requireUser);
const mockedGetProject = vi.mocked(getProject);
const mockedSaveDataset = vi.mocked(saveDataset);
const mockedRecordAudit = vi.mocked(recordTrainingAudit);
const mockedInspect = vi.mocked(inspectHubDataset);
const mockedDownload = vi.mocked(downloadHubFile);

const CSV = "instruction,response\nQ1,A1\nQ2,A2\nQ3,A3\nQ4,A4\nQ5,A5";

function hubDetailFixture(files: Array<{ name: string; sizeBytes: number; downloadable: boolean }>) {
  return {
    provider: "kaggle" as const,
    ref: "owner/jeu",
    name: "Jeu",
    description: "",
    sizeBytes: null,
    downloads: null,
    likes: null,
    license: "CC0",
    lastModified: null,
    tags: [],
    files,
    splits: [] as Array<{ name: string; rows: number | null }>,
    columns: [],
    previewRows: [] as Array<Record<string, unknown>>,
    notes: ["note honnête"],
    inspectedAt: "2026-10-18T10:00:00.000Z",
  };
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("https://gen3ia.local/api/training/projects/proj-1/datasets/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const routeParams = { params: Promise.resolve({ id: "proj-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockedRequireUser.mockResolvedValue({ uid: "user-1" } as never);
  mockedGetProject.mockResolvedValue({ id: "proj-1", ownerId: "user-1" } as never);
  mockedInspect.mockResolvedValue(
    hubDetailFixture([
      { name: "train.csv", sizeBytes: 120, downloadable: true },
      { name: "README.md", sizeBytes: 400, downloadable: false },
    ]) as never,
  );
  mockedDownload.mockResolvedValue({
    buffer: Buffer.from(CSV, "utf8"),
    contentType: "text/csv",
  } as never);
});

describe("POST /api/training/projects/[id]/datasets/import", () => {
  it("renvoie 401 sans authentification", async () => {
    mockedRequireUser.mockRejectedValue(unauthorized());
    const response = await POST(postRequest({ provider: "kaggle", ref: "owner/jeu" }), routeParams);
    expect(response.status).toBe(401);
  });

  it("renvoie 404 quand le projet n'existe pas", async () => {
    mockedGetProject.mockResolvedValue(null as never);
    const response = await POST(postRequest({ provider: "kaggle", ref: "owner/jeu" }), routeParams);
    expect(response.status).toBe(404);
  });

  it("renvoie 400 pour un fournisseur inconnu", async () => {
    const response = await POST(postRequest({ provider: "github", ref: "owner/jeu" }), routeParams);
    expect(response.status).toBe(400);
  });

  it("importe réellement : téléchargement, validation du contenu, stockage, audit", async () => {
    const response = await POST(
      postRequest({ provider: "kaggle", ref: "owner/jeu", split: "validation" }),
      routeParams,
    );
    expect(response.status).toBe(201);
    const data = (await response.json()) as {
      datasets: Array<{ name: string; rows: number }>;
      skipped: Array<{ name: string; reason: string }>;
      origin: { provider: string; ref: string };
    };
    expect(data.datasets).toHaveLength(1);
    expect(data.datasets[0]).toMatchObject({ name: "train.csv", rows: 5 });
    expect(data.skipped.some((s) => s.name === "README.md" && /non ingérable/i.test(s.reason))).toBe(true);
    expect(data.origin).toMatchObject({ provider: "kaggle", ref: "owner/jeu" });

    expect(mockedDownload).toHaveBeenCalledWith("kaggle", "owner/jeu", "train.csv", expect.any(Number));
    expect(mockedSaveDataset).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        source: "kaggle",
        hubRef: "owner/jeu",
        split: "validation",
        status: "valid",
        stats: expect.objectContaining({ rows: 5, pairs: 1 }),
        originMetadata: expect.objectContaining({ provider: "kaggle", license: "CC0" }),
        findings: expect.arrayContaining([expect.objectContaining({ code: "hub-import" })]),
      }),
    );
    expect(mockedRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "dataset.imported", entityType: "dataset", projectId: "proj-1" }),
    );
  });

  it("renvoie 422 avec les raisons quand aucun fichier n'est ingérable", async () => {
    mockedInspect.mockResolvedValue(
      hubDetailFixture([{ name: "donnees.parquet", sizeBytes: 900, downloadable: false }]) as never,
    );
    const response = await POST(postRequest({ provider: "huggingface", ref: "org/jeu" }), routeParams);
    expect(response.status).toBe(422);
    const data = (await response.json()) as { skipped: Array<{ name: string; reason: string }> };
    expect(data.skipped.length).toBeGreaterThan(0);
    expect(mockedDownload).not.toHaveBeenCalled();
  });

  it("écarte un fichier dont le téléchargement échoue mais importe les autres", async () => {
    mockedInspect.mockResolvedValue(
      hubDetailFixture([
        { name: "a.csv", sizeBytes: 50, downloadable: true },
        { name: "b.csv", sizeBytes: 60, downloadable: true },
      ]) as never,
    );
    mockedDownload.mockImplementation(((_provider: string, _ref: string, fileName: string) =>
      fileName === "b.csv"
        ? Promise.reject(new Error("hub expiré"))
        : Promise.resolve({ buffer: Buffer.from(CSV, "utf8"), contentType: "text/csv" })) as never);

    const response = await POST(postRequest({ provider: "kaggle", ref: "owner/jeu" }), routeParams);
    expect(response.status).toBe(201);
    const data = (await response.json()) as {
      datasets: Array<{ name: string }>;
      skipped: Array<{ name: string; reason: string }>;
    };
    expect(data.datasets.map((d) => d.name)).toEqual(["a.csv"]);
    expect(data.skipped.some((s) => s.name === "b.csv" && /hub expiré/.test(s.reason))).toBe(true);
  });
});

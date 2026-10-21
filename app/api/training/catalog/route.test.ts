import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/* ------------------------------------------------------------------ */
/* Catalogue « CONFIG ONLY » (demande utilisateur n° 6) :               */
/*  - moteurs, modèles de base et quotas restent exposés (config) ;     */
/*  - la sonde fournisseurs brute (worker GPU, inventaire matériel,     */
/*    flags de simulation) est agrégée en un résumé d'exécution —       */
/*    plus aucun détail de mécanique interne ne sort de la route.       */
/* ------------------------------------------------------------------ */

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/training/catalog", () => ({ buildCatalog: vi.fn() }));
vi.mock("@/lib/training/quotas", () => ({
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

import { requireUser } from "@/lib/security/authenticated-request";
import { unauthorized } from "@/lib/security/http-errors";
import { buildCatalog } from "@/lib/training/catalog";
import { GET } from "./route";

const mockedRequireUser = vi.mocked(requireUser);
const mockedBuildCatalog = vi.mocked(buildCatalog);

const baseCatalog = {
  engines: [
    {
      id: "gen3-native",
      name: "Gen3 natif",
      description: "Moteur neuronal natif (CPU)",
      families: ["text"],
      methods: ["full-training", "finetune", "rag", "eval-only"],
      available: true,
      minVramGb: 0,
      parameters: [],
      knownLimits: [],
    },
  ],
  baseModels: [
    { id: "Qwen/Qwen2.5-0.5B-Instruct", name: "Qwen2.5 0.5B Instruct", family: "text" as const, params: "0,5 Md", minVramGb: 4, recommendedFor: ["qlora"], notes: "" },
  ],
  providers: [] as Array<{ id: string; label: string; configured: boolean; gpus: Array<{ name: string; vramGb: number; available: boolean }>; simulated: boolean }>,
  quotas: {
    maxProjects: 10,
    maxConcurrentJobs: 1,
    maxUploadMb: 200,
    maxDatasetsPerProject: 50,
    maxModelsPerProject: 20,
  },
};

function getRequest(): NextRequest {
  return new NextRequest("https://gen3ia.local/api/training/catalog");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRequireUser.mockResolvedValue({ uid: "user-1" } as never);
});

describe("GET /api/training/catalog — surface config only", () => {
  it("répond 401 sans authentification", async () => {
    mockedRequireUser.mockRejectedValue(unauthorized());
    const response = await getRequestRunner();
    expect(response.status).toBe(401);
  });

  it("n'expose PLUS la sonde fournisseurs (worker, GPU, flags) — résumé d'exécution uniquement", async () => {
    mockedBuildCatalog.mockResolvedValue({
      ...baseCatalog,
      providers: [
        { id: "gen3-local", label: "Gen3 natif", configured: true, gpus: [], simulated: false },
        {
          id: "worker-http",
          label: "Worker GPU distant",
          configured: true,
          gpus: [{ name: "RTX 4090", vramGb: 24, available: true }],
          simulated: false,
        },
        { id: "mock", label: "Simulation", configured: true, gpus: [], simulated: true },
      ],
    });
    const response = await getRequestRunner();
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      catalog: Record<string, unknown> & {
        execution?: { nativeAvailable: boolean; gpuAvailable: boolean; simulationDetected: boolean };
        engines: unknown[];
        baseModels: unknown[];
      };
    };
    // Aucune mécanique interne ne sort : ni champ providers, ni inventaire GPU.
    expect(data.catalog.providers).toBeUndefined();
    expect(JSON.stringify(data.catalog)).not.toContain("RTX 4090");
    expect(JSON.stringify(data.catalog)).not.toContain("worker-http");
    expect(data.catalog.execution).toEqual({ nativeAvailable: true, gpuAvailable: true, simulationDetected: true });
    expect(data.catalog.engines).toHaveLength(1);
    expect(data.catalog.baseModels).toHaveLength(1);
  });

  it("conserve les quotas utilisateur inchangés et ajoute la visibilité stockage/minutes", async () => {
    mockedBuildCatalog.mockResolvedValue({ ...baseCatalog, providers: [] });
    const response = await getRequestRunner();
    const data = (await response.json()) as {
      catalog: { quotas: Record<string, number>; execution: { nativeAvailable: boolean; gpuAvailable: boolean } };
    };
    expect(data.catalog.quotas.maxUploadMb).toBe(200);
    expect(data.catalog.quotas.maxDatasetsPerProject).toBe(50);
    expect(data.catalog.quotas.maxModelsPerProject).toBe(20);
    expect(data.catalog.quotas.maxStorageMb).toBe(2048);
    expect(data.catalog.quotas.maxTrainingMinutesPerMonth).toBe(60);
    expect(data.catalog.execution).toEqual({ nativeAvailable: false, gpuAvailable: false, simulationDetected: false });
  });
});

async function getRequestRunner(): Promise<Response> {
  return GET(getRequest());
}

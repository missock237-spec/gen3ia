import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/* ------------------------------------------------------------------ */
/* Contrat d'API des projets d'entraînement (Task AI Training Studio). */
/* 401 sans session, 400 champs invalides, 201 création, isolation.    */
/* ------------------------------------------------------------------ */

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/training/repository", () => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
}));
vi.mock("@/lib/training/quotas", () => ({
  assertCanCreateProject: vi.fn(),
  assertAssetQuota: vi.fn(),
  assertUploadSize: vi.fn().mockImplementation(() => undefined),
  assertJobConcurrency: vi.fn(),
  trainingQuotas: vi.fn(() => ({
    maxProjects: 10,
    maxConcurrentJobs: 1,
    maxUploadBytes: 200 * 1024 * 1024,
    maxDatasetsPerProject: 50,
    maxModelsPerProject: 20,
  })),
}));

import { requireUser } from "@/lib/security/authenticated-request";
import { unauthorized } from "@/lib/security/http-errors";
import { assertCanCreateProject } from "@/lib/training/quotas";
import { createProject, listProjects } from "@/lib/training/repository";
import { GET, POST } from "./route";

const mockedRequireUser = vi.mocked(requireUser);
const mockedAssertQuota = vi.mocked(assertCanCreateProject);
const mockedList = vi.mocked(listProjects);
const mockedCreate = vi.mocked(createProject);

function getRequest(): NextRequest {
  return new NextRequest("https://gen3ia.local/api/training/projects");
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("https://gen3ia.local/api/training/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRequireUser.mockResolvedValue({ uid: "user-1" } as never);
  mockedAssertQuota.mockResolvedValue(undefined);
});

describe("GET /api/training/projects", () => {
  it("renvoie 401 sans authentification", async () => {
    mockedRequireUser.mockRejectedValue(unauthorized());
    const response = await getRequestRunner();
    expect(response.status).toBe(401);
  });

  it("liste uniquement les projets de l'utilisateur appelant", async () => {
    mockedList.mockResolvedValue([
      {
        v: 1, id: "p1", ownerId: "user-1", name: "Projet A", description: "", family: "text",
        objective: "", primaryLanguage: "fr", dataTypes: [], mode: "assisted", status: "active",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const data = (await response.json()) as { projects: Array<{ ownerId: string }> };
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0].ownerId).toBe("user-1");
    expect(mockedList).toHaveBeenCalledWith("user-1");
  });
});

async function getRequestRunner(): Promise<Response> {
  // Wrapper explicite pour lisibilité du test 401.
  return GET(getRequest());
}

describe("POST /api/training/projects", () => {
  it("valide les champs et refuse un nom vide", async () => {
    const response = await POST(postRequest({ name: "", family: "text" }));
    expect(response.status).toBe(400);
  });

  it("refuse une famille inconnue", async () => {
    const response = await POST(postRequest({ name: "Test", family: "quantique" }));
    expect(response.status).toBe(400);
  });

  it("crée le projet au nom de l'utilisateur authentifié", async () => {
    mockedCreate.mockResolvedValue({
      v: 1, id: "nouveau", ownerId: "user-1", name: "Test", description: "", family: "text",
      objective: "", primaryLanguage: "fr", dataTypes: [], mode: "auto", status: "active",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const response = await POST(postRequest({ name: "Test", family: "text", mode: "auto" }));
    expect(response.status).toBe(201);
    expect(mockedCreate).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ name: "Test", family: "text", mode: "auto" }),
    );
  });

  it("transmet le dépassement de quota en erreur lisible", async () => {
    mockedAssertQuota.mockRejectedValue(new Error("Quota atteint : 10 projets d'entraînement actifs maximum."));
    const response = await POST(postRequest({ name: "Test", family: "text" }));
    expect(response.status).toBe(400);
    const data = (await response.json()) as { error?: string };
    expect(data.error).toContain("Quota atteint");
  });
});

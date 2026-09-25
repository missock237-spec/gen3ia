import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomApiRecord } from "./repository";

/**
 * Tests du client d'appel réel : fonctions pures (URL, auth) + exécution
 * complète avec fetch simulé (aucun réseau réel en test).
 */

const { listCustomApisMock, getCustomApiMock, findCustomApiByNameMock, touchCustomApiCallMock } = vi.hoisted(() => ({
  listCustomApisMock: vi.fn(),
  getCustomApiMock: vi.fn(),
  findCustomApiByNameMock: vi.fn(),
  touchCustomApiCallMock: vi.fn(),
}));

vi.mock("./repository", () => ({
  listCustomApis: (...args: unknown[]) => listCustomApisMock(...args),
  getCustomApi: (...args: unknown[]) => getCustomApiMock(...args),
  findCustomApiByName: (...args: unknown[]) => findCustomApiByNameMock(...args),
  touchCustomApiCall: (...args: unknown[]) => touchCustomApiCallMock(...args),
}));

const publicApi: CustomApiRecord = {
  id: "api-1",
  userId: "user-1",
  name: "Exemple API",
  baseUrl: "https://api.exemple.com/v1",
  authType: "none",
  enabled: true,
  source: "form",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const bearerApi: CustomApiRecord = {
  ...publicApi,
  id: "api-2",
  name: "Privée",
  baseUrl: "https://privee.exemple.com",
  authType: "bearer",
  authValue: "sk_secret_123456",
};

describe("joinApiUrl — construction réelle de l'URL", () => {
  it("réunit base + chemin sans double slash", async () => {
    const { joinApiUrl } = await import("./client");
    expect(joinApiUrl("https://api.exemple.com/v1/", "/users/1").toString()).toBe("https://api.exemple.com/v1/users/1");
  });

  it("ajoute les paramètres de requête", async () => {
    const { joinApiUrl } = await import("./client");
    const url = joinApiUrl("https://api.exemple.com", "/users", { limit: "5", page: "2" });
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("page")).toBe("2");
  });
});

describe("buildAuthHeaders / applyQueryAuth — authentification réelle", () => {
  it("applique le bearer", async () => {
    const { buildAuthHeaders } = await import("./client");
    expect(buildAuthHeaders(bearerApi).authorization).toBe("Bearer sk_secret_123456");
  });

  it("applique l'en-tête personnalisé", async () => {
    const { buildAuthHeaders } = await import("./client");
    const headers = buildAuthHeaders({ ...publicApi, authType: "header", authHeader: "X-API-Key", authValue: "cle12345" });
    expect(headers["x-api-key"]).toBe("cle12345");
  });

  it("ajoute le secret en paramètre d'URL (authType=query)", async () => {
    const { applyQueryAuth } = await import("./client");
    const url = applyQueryAuth({ ...publicApi, authType: "query", queryKey: "api_key", authValue: "cle-query" }, new URL("https://api.exemple.com/data"));
    expect(url.searchParams.get("api_key")).toBe("cle-query");
  });
});

describe("resolveCustomApi — ciblage de l'API de l'utilisateur", () => {
  beforeEach(() => {
    listCustomApisMock.mockReset();
    getCustomApiMock.mockReset();
    findCustomApiByNameMock.mockReset();
  });

  it("résout par nom", async () => {
    const { resolveCustomApi } = await import("./client");
    findCustomApiByNameMock.mockResolvedValue(bearerApi);
    const resolved = await resolveCustomApi("user-1", { apiName: "Privée" });
    expect(resolved.id).toBe("api-2");
  });

  it("échoue proprement sans API enregistrée", async () => {
    const { resolveCustomApi, CustomApiError } = await import("./client");
    listCustomApisMock.mockResolvedValue([]);
    await expect(resolveCustomApi("user-1", {})).rejects.toBeInstanceOf(CustomApiError);
  });

  it("demande de préciser l'API quand plusieurs sont actives", async () => {
    const { resolveCustomApi } = await import("./client");
    listCustomApisMock.mockResolvedValue([publicApi, bearerApi]);
    await expect(resolveCustomApi("user-1", {})).rejects.toThrow(/Précisez laquelle/);
  });

  it("utilise l'unique API activée sans précision", async () => {
    const { resolveCustomApi } = await import("./client");
    listCustomApisMock.mockResolvedValue([bearerApi]);
    const resolved = await resolveCustomApi("user-1", {});
    expect(resolved.id).toBe("api-2");
  });
});

describe("executeCustomApiCall — appel HTTP réel (fetch simulé)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    listCustomApisMock.mockReset().mockResolvedValue([publicApi]);
    getCustomApiMock.mockReset();
    findCustomApiByNameMock.mockReset();
    touchCustomApiCallMock.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("exécute un GET réel et restitue le JSON de la réponse", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 1, email: "sve@apexblogs.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { executeCustomApiCall } = await import("./client");
    const result = await executeCustomApiCall("user-1", { path: "/users/1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(calledUrl.toString()).toBe("https://api.exemple.com/v1/users/1");
    expect(init.method).toBe("GET");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ id: 1, email: "sve@apexblogs.com" });
    expect(touchCustomApiCallMock).toHaveBeenCalledWith("api-1", "success", 200);
  });

  it("restaure un statut 404 réel sans le masquer", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const { executeCustomApiCall } = await import("./client");
    const result = await executeCustomApiCall("user-1", { path: "/inconnu" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.json).toEqual({ error: "not found" });
  });

  it("bloquent les adresses internes (garde SSRF)", async () => {
    listCustomApisMock.mockResolvedValue([{ ...publicApi, baseUrl: "http://169.254.169.254/latest" }]);
    const { executeCustomApiCall, CustomApiError } = await import("./client");
    await expect(executeCustomApiCall("user-1", {})).rejects.toBeInstanceOf(CustomApiError);
  });

  it("transmet le corps JSON et content-type pour un POST (écriture)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ created: true }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const { executeCustomApiCall } = await import("./client");
    const result = await executeCustomApiCall("user-1", { method: "POST", path: "/users", body: { name: "Marc" } });

    const [, init] = globalThis.fetch.mock.calls[0] as [URL, RequestInit];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "Marc" }));
    expect(result.status).toBe(201);
  });
});

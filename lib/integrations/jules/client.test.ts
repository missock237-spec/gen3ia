import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 121 — CLIENT HTTP JULES (lib/integrations/jules/client.ts).
 *
 * Wrapper fetch réutilisable (mêmes contrat et authentification que les
 * tools jules.* du registre) : les tests verrouillent le CORPS de la
 * création de session (sourceContext GitHub + prompt), l'en-tête
 * X-Goog-Api-Key, la lecture d'état (nom nu ou complet), et l'erreur
 * honnête sur réponse non-ok.
 */

import { isJulesConfigured, julesCreateSession, julesGetSession, parseGithubRepo } from "./client";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("JULES_API_KEY", "test-key-123");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockReset();
});

describe("client Jules — authentification et création de session", () => {
  it("POST /sessions avec sourceContext GitHub, prompt et X-Goog-Api-Key", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ name: "sessions/abc-123", state: "IN_PROGRESS" }),
    });

    const created = await julesCreateSession({ githubRepo: "acme/api", prompt: "corrige le bug de login" });

    expect(created).toEqual({ session: "sessions/abc-123", state: "IN_PROGRESS" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://jules.googleapis.com/v1alpha/sessions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("test-key-123");
    const body = JSON.parse(String(init.body)) as {
      sourceContext: { source: string; githubRepo: { owner: string; repo: string } };
      prompt: string;
    };
    expect(body.sourceContext).toEqual({
      source: "repos/acme/api",
      githubRepo: { owner: "acme", repo: "api" },
    });
    expect(body.prompt).toBe("corrige le bug de login");
  });

  it("transmet la branche de départ quand elle est fournie", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ name: "sessions/xyz" }) });
    await julesCreateSession({ githubRepo: "acme/api", prompt: "p", startingBranch: "feat/login" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).startingBranch).toBe("feat/login");
  });

  it("respecte la surcharge JULES_API_BASE_URL", async () => {
    vi.stubEnv("JULES_API_BASE_URL", "https://jules-staging.example/v1alpha");
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ name: "sessions/s" }) });
    await julesGetSession("s");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://jules-staging.example/v1alpha/sessions/s");
  });

  it("échoue honnêtement (statut + extrait du corps) sur réponse non-ok", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "PERMISSION_DENIED: repository access required",
    });
    await expect(julesCreateSession({ githubRepo: "acme/api", prompt: "p" })).rejects.toThrow(
      /Jules API 403.*PERMISSION_DENIED/,
    );
  });

  it("refuse sans clé configurée (aucun appel réseau)", async () => {
    vi.stubEnv("JULES_API_KEY", "");
    expect(isJulesConfigured()).toBe(false);
    await expect(julesCreateSession({ githubRepo: "acme/api", prompt: "p" })).rejects.toThrow(/JULES_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("client Jules — lecture de session", () => {
  it("GET /sessions/{name} avec le nom complet normalisé", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ name: "sessions/abc", state: "COMPLETED", outputs: [{ url: "https://pr" }] }),
    });
    const snapshot = await julesGetSession("sessions/abc");
    expect(snapshot.state).toBe("COMPLETED");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://jules.googleapis.com/v1alpha/sessions/abc");
    expect(init.method).toBeUndefined();
  });

  it("accepte un nom de session nu", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ state: "IN_PROGRESS" }) });
    await julesGetSession("abc");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://jules.googleapis.com/v1alpha/sessions/abc");
  });
});

describe("parseGithubRepo", () => {
  it("découpe owner/repo", () => {
    expect(parseGithubRepo("acme/api")).toEqual({ owner: "acme", repo: "api" });
  });

  it("rejette un format incomplet", () => {
    expect(() => parseGithubRepo("acme")).toThrow(/owner\/repo/);
  });
});

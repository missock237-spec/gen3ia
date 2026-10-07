import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { Gen3iaClient } from "../src/client.js";
import {
  Gen3iaApiError,
  Gen3iaConfigurationError,
  Gen3iaNetworkError,
} from "../src/errors.js";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

type MockReply = Response | Error | ((init: RequestInit, url: string) => Response);

/**
 * Fabrique un fetch séquentiel injectable : chaque appel consomme une
 * réponse de la file. Une Error de la file simule une panne réseau.
 */
function fetchMock(replies: MockReply[]) {
  const calls: RecordedCall[] = [];
  const impl = (async (url: unknown, init: RequestInit = {}) => {
    const next = replies.shift();
    calls.push({ url: String(url), init });
    if (!next) throw new Error("fetch mock épuisé : requête inattendue");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(init, String(url));
    return next;
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("Gen3iaClient — requêtes de base", () => {
  it("health() : GET sans authentification, baseUrl normalisée (slash final retiré)", async () => {
    const { fetch: impl, calls } = fetchMock([jsonResponse({ ok: true, service: "gen3ia", time: "2026-01-01T00:00:00Z" })]);
    const client = new Gen3iaClient({ baseUrl: "https://api.example.org///", fetch: impl });
    const health = await client.health();

    expect(health.service).toBe("gen3ia");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.org/api/public/health");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("agents.run() : POST /api/v1 avec Bearer g3x_ + X-Gen3ia-Project-Id", async () => {
    const { fetch: impl, calls } = fetchMock([
      jsonResponse({ executionId: "exec_1", agent: { id: "a1", name: "A", type: "universal" }, status: "completed", outputs: { out: "ok" }, observations: [] }),
    ]);
    const client = new Gen3iaClient({ apiKey: "g3x_test_key", projectId: "proj_1", fetch: impl });
    const result = await client.agents.run("agent_1", { objective: "Rédiger un rapport" });

    expect(result.executionId).toBe("exec_1");
    expect(calls[0]?.url).toBe("https://gen3ia.online/api/v1/agents/agent_1/run");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer g3x_test_key");
    expect(headers["X-Gen3ia-Project-Id"]).toBe("proj_1");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ objective: "Rédiger un rapport" });
  });

  it("agents.run() sans clé ou sans projet : Gen3iaConfigurationError AVANT toute requête", async () => {
    const { fetch: impl, calls } = fetchMock([]);
    const sansCle = new Gen3iaClient({ projectId: "proj_1", fetch: impl });
    const sansProjet = new Gen3iaClient({ apiKey: "g3x_test_key", fetch: impl });

    await expect(sansCle.agents.run("a", { objective: "x" })).rejects.toBeInstanceOf(Gen3iaConfigurationError);
    await expect(sansProjet.agents.run("a", { objective: "x" })).rejects.toBeInstanceOf(Gen3iaConfigurationError);
    expect(calls).toHaveLength(0);
  });

  it("missions.* sans token Firebase : Gen3iaConfigurationError", async () => {
    const { fetch: impl, calls } = fetchMock([]);
    const client = new Gen3iaClient({ fetch: impl });
    await expect(client.missions.run({ objective: "Mission de test" })).rejects.toBeInstanceOf(Gen3iaConfigurationError);
    await expect(client.missions.get("run-1")).rejects.toBeInstanceOf(Gen3iaConfigurationError);
    expect(calls).toHaveLength(0);
  });

  it("firebaseToken fournisseur : résolu à chaque requête (token de courte durée)", async () => {
    const { fetch: impl, calls } = fetchMock([
      jsonResponse({ runId: "r1", status: "queued", async: true, executionId: "e1", statusUrl: "/s", streamUrl: "/f", pollSeconds: 2 }, 202),
      jsonResponse({ runId: "r1", status: "completed", pendingCount: 0, attempts: 1, timeline: [], createdAtMs: 1, updatedAtMs: 2 }),
    ]);
    let issueCount = 0;
    const client = new Gen3iaClient({
      firebaseToken: () => {
        issueCount += 1;
        return `tok-${issueCount}`;
      },
      fetch: impl,
    });

    await client.missions.run({ objective: "Mission de test" });
    await client.missions.get("r1");
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: "Bearer tok-1" });
    expect(calls[1]?.init.headers).toMatchObject({ Authorization: "Bearer tok-2" });
  });
});

describe("Gen3iaClient — missions (file QStash)", () => {
  it("missions.run() : réponse 202 async discriminée en MissionQueued", async () => {
    const { fetch: impl, calls } = fetchMock([
      jsonResponse(
        { runId: "uuid-1", executionId: "exec-1", status: "queued", async: true, statusUrl: "/api/agents/runs/uuid-1", streamUrl: "/api/agents/runs/uuid-1/stream", pollSeconds: 2 },
        202,
      ),
    ]);
    const client = new Gen3iaClient({ firebaseToken: "tok", fetch: impl });
    const result = await client.missions.run({ objective: "Veille concurrentielle", mode: "async" });

    expect(result.async).toBe(true);
    if (result.async) expect(result.runId).toBe("uuid-1");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ objective: "Veille concurrentielle", mode: "async" });
  });

  it("missions.run() : réponse 200 sync discriminée en MissionSyncResult", async () => {
    const { fetch: impl } = fetchMock([
      jsonResponse({ executionId: "exec-2", status: "completed", outputs: { out: "voilà" }, observations: [], async: false }),
    ]);
    const client = new Gen3iaClient({ firebaseToken: "tok", fetch: impl });
    const result = await client.missions.run({ objective: "Résumé rapide", mode: "sync" });

    expect(result.async).toBe(false);
    if (!result.async) expect(result.outputs).toMatchObject({ out: "voilà" });
  });

  it("missions.run() avec orgId : transmis au serveur (cloisonnement Task 58)", async () => {
    const { fetch: impl, calls } = fetchMock([
      jsonResponse({ runId: "r", executionId: "e", status: "queued", async: true, statusUrl: "/s", streamUrl: "/f", pollSeconds: 2 }, 202),
    ]);
    const client = new Gen3iaClient({ firebaseToken: "tok", fetch: impl });
    await client.missions.run({ objective: "Mission d'équipe", orgId: "org_abc" });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ orgId: "org_abc" });
  });
});

describe("Gen3iaClient — erreurs structurées", () => {
  it("Gen3iaApiError : status + requestId (en-tête) + message serveur", async () => {
    const { fetch: impl } = fetchMock([
      jsonResponse({ error: "Mission introuvable" }, 404, { "x-request-id": "req-42" }),
    ]);
    const client = new Gen3iaClient({ firebaseToken: "tok", fetch: impl });
    const error = await client.missions.get("inconnu").catch((e) => e);

    expect(error).toBeInstanceOf(Gen3iaApiError);
    expect((error as Gen3iaApiError).status).toBe(404);
    expect((error as Gen3iaApiError).requestId).toBe("req-42");
    expect((error as Gen3iaApiError).message).toBe("Mission introuvable");
  });

  it("erreur de validation zod (flatten) : issues préservées, message non vide", async () => {
    const { fetch: impl } = fetchMock([
      jsonResponse({ error: { formErrors: ["Objective trop court"], fieldErrors: {} } }, 400),
    ]);
    const client = new Gen3iaClient({ firebaseToken: "tok", fetch: impl });
    const error = (await client.missions.run({ objective: "ab" }).catch((e) => e)) as Gen3iaApiError;

    expect(error.status).toBe(400);
    expect(error.message).toBe("Objective trop court");
    expect(error.issues).toMatchObject({ formErrors: ["Objective trop court"] });
  });

  it("429 : retryAfterMs dérivé de l'en-tête retry-after (secondes → ms)", async () => {
    const { fetch: impl } = fetchMock([
      jsonResponse({ error: "Trop de déclenchements pour ce webhook." }, 429, { "retry-after": "7" }),
    ]);
    const client = new Gen3iaClient({ fetch: impl });
    const error = (await client.webhooks.trigger("a".repeat(32), { event: "push" }).catch((e) => e)) as Gen3iaApiError;

    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(7_000);
  });

  it("409 webhook : conflit d'exécution exposé comme Gen3iaApiError", async () => {
    const { fetch: impl } = fetchMock([
      jsonResponse({ error: "L'agent a déjà une exécution en cours — déclenchement ignoré.", scheduleId: "s1" }, 409),
    ]);
    const client = new Gen3iaClient({ fetch: impl });
    const error = (await client.webhooks.trigger("b".repeat(32)).catch((e) => e)) as Gen3iaApiError;
    expect(error.status).toBe(409);
  });

  it("réponse 200 non JSON : Gen3iaApiError explicite", async () => {
    const { fetch: impl } = fetchMock([new Response("<html>oops</html>", { status: 200 })]);
    const client = new Gen3iaClient({ fetch: impl });
    await expect(client.health()).rejects.toBeInstanceOf(Gen3iaApiError);
  });
});

describe("Gen3iaClient — politique de retry (GET uniquement)", () => {
  it("GET : panne réseau puis succès → retenté (backoff base réduite pour le test)", async () => {
    const { fetch: impl, calls } = fetchMock([
      makeNetworkFailure(),
      jsonResponse({ ok: true, service: "gen3ia", time: "t" }),
    ]);
    const client = new Gen3iaClient({ fetch: impl, maxRetries: 2, retryBaseDelayMs: 1 });
    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("POST : JAMAIS retenté (double facturation interdite)", async () => {
    const { fetch: impl, calls } = fetchMock([makeNetworkFailure()]);
    const client = new Gen3iaClient({ firebaseToken: "tok", fetch: impl, maxRetries: 3, retryBaseDelayMs: 1 });
    await expect(client.missions.run({ objective: "Mission facturée" })).rejects.toBeInstanceOf(Gen3iaNetworkError);
    expect(calls).toHaveLength(1);
  });

  it("GET : 503 retenté puis succès", async () => {
    const { fetch: impl, calls } = fetchMock([
      jsonResponse({ error: "indisponible" }, 503),
      jsonResponse({ ok: true, service: "gen3ia", time: "t" }),
    ]);
    const client = new Gen3iaClient({ fetch: impl, maxRetries: 1, retryBaseDelayMs: 1 });
    expect((await client.health()).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("GET : 404 NON retenté (erreur définitive)", async () => {
    const { fetch: impl, calls } = fetchMock([jsonResponse({ error: "introuvable" }, 404)]);
    const client = new Gen3iaClient({ fetch: impl, maxRetries: 3, retryBaseDelayMs: 1 });
    await expect(client.health()).rejects.toBeInstanceOf(Gen3iaApiError);
    expect(calls).toHaveLength(1);
  });
});

/** Panne réseau simulée : le fetch global doit jeter, le SDK enveloppe en Gen3iaNetworkError. */
function makeNetworkFailure(): Error {
  return Object.assign(new Error("fetch failed: ECONNRESET"), { simulated: true });
}

// ─── Task 104-c : normalisation baseUrl linéaire (CodeQL #53 polynomial-redos) ───

describe("Gen3iaClient — normalisation baseUrl linéaire (CodeQL js/polynomial-redos)", () => {
  it("baseUrl pathologique (100 000 slashs) : normalisation < 100 ms, résultat correct", async () => {
    // Chaîne adversariale maximisant le backtracking d'une regex /\/+$/ :
    // si la normalisation était polynomiale, cette construction exploserait.
    const pathological = "https://api.example.org" + "/".repeat(100_000);
    const { fetch: impl, calls } = fetchMock([
      jsonResponse({ ok: true, service: "gen3ia", time: "2026-01-01T00:00:00Z" }),
    ]);

    const start = performance.now();
    const client = new Gen3iaClient({ baseUrl: pathological, fetch: impl });
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(100); // verrou d'absence de backtracking polynomial
    const health = await client.health();
    expect(health.ok).toBe(true);
    // Tous les slashs terminaux sont retirés, l'URL finale reste intacte.
    expect(calls[0]?.url).toBe("https://api.example.org/api/public/health");
  });

  it("garde structurelle : client.ts ne contient plus de regex sur les slashs finaux", () => {
    const source = readFileSync(path.join(import.meta.dirname, "../src/client.ts"), "utf8");
    // La séquence d'origine `.replace(/\/+$/, "")` ne doit plus exister dans
    // le client (commentaires compris) — normalisation 100 % boucle.
    expect(source).not.toContain(".replace(/\\/+$/");
    expect(source).toContain("trimTrailingSlashes");
  });
});

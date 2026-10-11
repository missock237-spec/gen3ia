import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Clés API entreprise `g3a_` (Task 126) — contrat de la couche sécurité :
 * génération/hash, création (plafond de clés actives), auth par Bearer ou
 * X-API-Key, scopes, quota par clé, révocation.
 *
 * Stockage : fake adminDb en mémoire (le moteur r2fs réel est couvert par
 * lib/r2fs). runFirestoreGuarded et enforceRateLimit sont isolés pour ne
 * dépendre ni de Firestore ni de Redis.
 */

const docs = new Map<string, Record<string, unknown>>();

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (id: string) => ({
        async get() {
          const data = docs.get(`${name}/${id}`);
          return { exists: Boolean(data), data: () => data };
        },
        async create(value: Record<string, unknown>) {
          if (docs.has(`${name}/${id}`)) throw new Error("already-exists");
          docs.set(`${name}/${id}`, { ...value });
          return undefined;
        },
        async update(patch: Record<string, unknown>) {
          const current = docs.get(`${name}/${id}`);
          if (!current) throw new Error("No document to update");
          docs.set(`${name}/${id}`, { ...current, ...patch });
          return undefined;
        },
      }),
      where: (field: string, _op: string, value: unknown) => ({
        limit: () => ({
          async get() {
            const matched = [...docs.entries()]
              .filter(([key, data]) => key.startsWith(`${name}/`) && data[field] === value)
              .map(([key, data]) => ({ id: key.slice(name.length + 1), data: () => data }));
            return { docs: matched };
          },
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/queue/firestore-guard", () => ({
  runFirestoreGuarded: (_label: string, op: () => Promise<unknown>) => op(),
}));

const enforceMock = vi.fn(async () => ({ allowed: true, remaining: 1, retryAfterMs: 0, distributed: false }));

vi.mock("./rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) => enforceMock(...args),
}));

import {
  API_KEY_PREFIX,
  createApiKey,
  extractApiKey,
  hashApiKey,
  listApiKeys,
  revokeApiKey,
  authenticateApiKey,
} from "./api-keys";
import { HttpError } from "./http-errors";

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://gen3ia.local/api/v1/agents/a1/run", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  docs.clear();
  enforceMock.mockClear();
  enforceMock.mockResolvedValue({ allowed: true, remaining: 1, retryAfterMs: 0, distributed: false });
});

describe("createApiKey / listApiKeys", () => {
  it("crée une clé g3a_ (hash SHA-256 persisté, jamais la clé)", async () => {
    const issued = await createApiKey({ ownerId: "u1", name: "n8n", scopes: ["agents", "read"] });
    expect(issued.key.startsWith("g3a_")).toBe(true);
    expect(issued.key.length).toBeGreaterThan(API_KEY_PREFIX.length + 20);
    const stored = docs.get(`apiKeys/${hashApiKey(issued.key)}`);
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(issued.key);
    expect(issued.view.scopes).toEqual(["agents", "read"]);
    expect(issued.view.prefix.startsWith("g3a_")).toBe(true);
  });

  it("rejette des scopes vides ou inconnus", async () => {
    await expect(createApiKey({ ownerId: "u1", name: "x", scopes: [] })).rejects.toThrow(HttpError);
    await expect(createApiKey({ ownerId: "u1", name: "x", scopes: ["nuke"] })).rejects.toThrow(HttpError);
  });

  it("plafonne le nombre de clés actives par compte", async () => {
    for (let index = 0; index < 10; index += 1) {
      await createApiKey({ ownerId: "u2", name: `k${index}`, scopes: ["read"] });
    }
    await expect(createApiKey({ ownerId: "u2", name: "trop", scopes: ["read"] })).rejects.toThrow(/Maximum de 10/);
    const views = await listApiKeys("u2");
    expect(views).toHaveLength(10);
  });
});

describe("revokeApiKey", () => {
  it("révoque soft et refuse un autre propriétaire", async () => {
    const issued = await createApiKey({ ownerId: "u1", name: "k", scopes: ["read"] });
    await expect(revokeApiKey("u2", issued.view.id)).rejects.toThrow(HttpError);
    const view = await revokeApiKey("u1", issued.view.id);
    expect(view.revokedAt).not.toBeNull();
    // Idempotent : re-révoquer ne lève pas.
    await expect(revokeApiKey("u1", issued.view.id)).resolves.toBeTruthy();
  });
});

describe("authenticateApiKey", () => {
  it("retourne null sans clé g3a_ (fallback possible) et lit Bearer ou X-API-Key", async () => {
    expect(await authenticateApiKey(requestWith({ authorization: "Bearer g3x_autre" }), "agents")).toBeNull();
    const issued = await createApiKey({ ownerId: "u1", name: "k", scopes: ["agents"] });

    const viaBearer = await authenticateApiKey(
      requestWith({ authorization: `Bearer ${issued.key}` }),
      "agents",
    );
    expect(viaBearer?.userId).toBe("u1");
    expect(viaBearer?.via).toBe("api_key");

    const viaHeader = await authenticateApiKey(
      requestWith({ "x-api-key": issued.key }),
      "agents",
    );
    expect(viaHeader?.userId).toBe("u1");
  });

  it("rejette une clé inconnue ou révoquée (401) et un scope manquant (403)", async () => {
    await expect(
      authenticateApiKey(requestWith({ authorization: "Bearer g3a_introuvable" }), "agents"),
    ).rejects.toMatchObject({ status: 401 });

    const issued = await createApiKey({ ownerId: "u1", name: "k", scopes: ["read"] });
    await expect(authenticateApiKey(requestWith({ authorization: `Bearer ${issued.key}` }), "agents")).rejects.toMatchObject({ status: 403 });

    await revokeApiKey("u1", issued.view.id);
    await expect(authenticateApiKey(requestWith({ authorization: `Bearer ${issued.key}` }), "read")).rejects.toMatchObject({ status: 401 });
  });

  it("applique le quota par clé (429) et marque lastUsedAt", async () => {
    const issued = await createApiKey({ ownerId: "u1", name: "k", scopes: ["agents"], rateLimitPerMinute: 5 });
    await authenticateApiKey(requestWith({ authorization: `Bearer ${issued.key}` }), "agents");
    const stored = docs.get(`apiKeys/${issued.view.id}`);
    expect((stored as { lastUsedAt: number | null }).lastUsedAt).not.toBeNull();

    enforceMock.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 42_000, distributed: false });
    await expect(
      authenticateApiKey(requestWith({ authorization: `Bearer ${issued.key}` }), "agents"),
    ).rejects.toMatchObject({ status: 429 });
    expect(enforceMock).toHaveBeenCalledWith(`apikey:${issued.view.id}`, { limit: 5, windowMs: 60_000 });
  });
});

describe("extractApiKey", () => {
  it("ignore les en-têtes sans clé g3a_", () => {
    expect(extractApiKey(requestWith({}))).toBe("");
    expect(extractApiKey(requestWith({ authorization: "Bearer g3x_dev" }))).toBe("");
    expect(extractApiKey(requestWith({ "x-api-key": "raw-token" }))).toBe("");
  });
});

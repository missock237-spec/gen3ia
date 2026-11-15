import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Clés API entreprise `g3a_` (Task 126 + demande utilisateur n°8) — contrat
 * de la couche sécurité : génération/hash, GATE PLAN PRO à la création (free
 * refusé 403, pro/entreprise acceptés — les clés existantes restent
 * valables, aucune révocation rétroactive), plafond de clés actives, auth
 * par Bearer ou X-API-Key, scopes, quota par clé, révocation.
 *
 * Stockage : fake adminDb en mémoire (le moteur r2fs réel est couvert par
 * lib/r2fs). runFirestoreGuarded et enforceRateLimit sont isolés pour ne
 * dépendre ni de Firestore ni de Redis. L'état d'abonnement lit
 * `userPlans/{uid}` dans le même fake (getPlanState réel).
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

/** Sème un abonnement actif sans expiration (état consultable userPlans/{uid}). */
function grantPlan(userId: string, planId: "pro" | "entreprise" | "modele-sur-mesure"): void {
  docs.set(`userPlans/${userId}`, {
    userId,
    planId,
    active: true,
    source: "checkout",
    activatedAt: Date.now(),
    expiresAt: null,
    lastSaleId: null,
    lastLicenseKey: null,
  });
}

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

describe("GATE PLAN PRO — création de clé API (demande utilisateur n°8)", () => {
  it("refuse un compte sans abonnement (plan gratuit implicite) avec un 403 explicite", async () => {
    await expect(createApiKey({ ownerId: "free-user", name: "n8n", scopes: ["agents"] })).rejects.toMatchObject({
      status: 403,
    });
    await expect(createApiKey({ ownerId: "free-user", name: "n8n", scopes: ["agents"] })).rejects.toThrow(
      /réservée au plan Pro ou supérieur/,
    );
    // Aucune clé n'a été créée.
    expect([...docs.keys()].filter((key) => key.startsWith("apiKeys/"))).toHaveLength(0);
  });

  it("accepte le plan Pro (clé créée, hash seul persisté)", async () => {
    grantPlan("pro-user", "pro");
    const issued = await createApiKey({ ownerId: "pro-user", name: "n8n", scopes: ["agents"] });
    expect(issued.key.startsWith("g3a_")).toBe(true);
    expect(docs.has(`apiKeys/${hashApiKey(issued.key)}`)).toBe(true);
  });

  it("accepte les plans supérieurs (entreprise, modele-sur-mesure)", async () => {
    grantPlan("ent-user", "entreprise");
    await expect(createApiKey({ ownerId: "ent-user", name: "k", scopes: ["read"] })).resolves.toBeTruthy();
    grantPlan("sm-user", "modele-sur-mesure");
    await expect(createApiKey({ ownerId: "sm-user", name: "k", scopes: ["read"] })).resolves.toBeTruthy();
  });

  it("un abonnement EXPIRÉ retombe sur le plan gratuit → création refusée (mais clés existantes non révoquées)", async () => {
    // Fenêtre d'accès dépassée depuis 10 jours (grâce de 3 jours incluse).
    docs.set("userPlans/expired-user", {
      userId: "expired-user",
      planId: "pro",
      active: false,
      source: "checkout",
      activatedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
      expiresAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
      lastSaleId: "sale-1",
      lastLicenseKey: null,
    });
    await expect(createApiKey({ ownerId: "expired-user", name: "k", scopes: ["read"] })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("les clés DÉJÀ créées restent valables après descente de plan (aucune révocation rétroactive)", async () => {
    grantPlan("down-user", "pro");
    const issued = await createApiKey({ ownerId: "down-user", name: "k", scopes: ["read"] });
    // Le plan expire : la clé existante reste authentifiable.
    docs.delete("userPlans/down-user");
    const identity = await authenticateApiKey(requestWith({ authorization: `Bearer ${issued.key}` }), "read");
    expect(identity?.userId).toBe("down-user");
    expect(identity?.via).toBe("api_key");
  });
});

describe("createApiKey / listApiKeys", () => {
  it("crée une clé g3a_ (hash SHA-256 persisté, jamais la clé)", async () => {
    grantPlan("u1", "pro");
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
    grantPlan("u1", "pro");
    await expect(createApiKey({ ownerId: "u1", name: "x", scopes: [] })).rejects.toThrow(HttpError);
    await expect(createApiKey({ ownerId: "u1", name: "x", scopes: ["nuke"] })).rejects.toThrow(HttpError);
  });

  it("plafonne le nombre de clés actives par compte", async () => {
    grantPlan("u2", "pro");
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
    grantPlan("u1", "pro");
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
    grantPlan("u1", "pro");
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

    grantPlan("u1", "pro");
    const issued = await createApiKey({ ownerId: "u1", name: "k", scopes: ["read"] });
    await expect(authenticateApiKey(requestWith({ authorization: `Bearer ${issued.key}` }), "agents")).rejects.toMatchObject({ status: 403 });

    await revokeApiKey("u1", issued.view.id);
    await expect(authenticateApiKey(requestWith({ authorization: `Bearer ${issued.key}` }), "read")).rejects.toMatchObject({ status: 401 });
  });

  it("applique le quota par clé (429) et marque lastUsedAt", async () => {
    grantPlan("u1", "pro");
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

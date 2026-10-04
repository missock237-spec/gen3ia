import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 96-c — dépôt agents résilient : la section Agent IA (GET /api/agents,
 * POST /api/agents, résolution d'agent du chat) survit au quota Firestore
 * épuisé via le miroir Supabase. ownerId est TOUJOURS explicite (les
 * payloads `agents` portent ownerId, pas userId). listAgentsForUser est
 * fail-soft : une org injoignable livre au pire les agents personnels.
 */

// ---------------------------------------------------------------------------
// État hoisted — Firestore factice
// ---------------------------------------------------------------------------

const firestoreState = vi.hoisted(() => ({
  docs: new Map<string, { exists: boolean; data?: Record<string, unknown> }>(),
  ops: [] as Array<{ kind: string; path: string; payload?: unknown }>,
  /** Quand défini, chaque get/set/create/query lève cette erreur (quota…). */
  failWith: null as unknown,
  queryResults: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/firebase/admin", () => ({
  FieldValue: {
    increment: (n: number) => ({ __increment: n }),
    delete: () => ({ __delete: true }),
    serverTimestamp: () => ({ __serverTimestamp: true }),
  },
  adminDb: {
    collection: (name: string) => ({
      doc: (id?: string) => {
        if (id === undefined) return { id: "new-agent-id" };
        const path = `${name}/${id}`;
        const throwIfFailing = () => {
          if (firestoreState.failWith) throw firestoreState.failWith;
        };
        return {
          create: async (payload: unknown) => {
            firestoreState.ops.push({ kind: "create", path, payload });
            throwIfFailing();
            firestoreState.docs.set(path, { exists: true, data: payload as Record<string, unknown> });
            return {};
          },
          get: async () => {
            firestoreState.ops.push({ kind: "get", path });
            throwIfFailing();
            const doc = firestoreState.docs.get(path);
            if (!doc?.exists) return { exists: false, data: () => undefined };
            return { exists: true, data: () => doc.data };
          },
          set: async (payload: unknown, opts?: unknown) => {
            firestoreState.ops.push({ kind: "set", path, payload, opts });
            throwIfFailing();
            const existing = firestoreState.docs.get(path);
            const merge = (opts as { merge?: boolean } | undefined)?.merge === true;
            firestoreState.docs.set(path, {
              exists: true,
              data: merge ? { ...(existing?.data ?? {}), ...(payload as object) } : (payload as Record<string, unknown>),
            });
            return {};
          },
          delete: async () => {
            firestoreState.ops.push({ kind: "delete", path });
            throwIfFailing();
            firestoreState.docs.delete(path);
            return {};
          },
        };
      },
      where: (field: string, op: string, value: unknown) => {
        const describe = `${name}?${field}${op}${JSON.stringify(value)}`;
        // Égalité filtrée comme le vrai Firestore (les requêtes résilientes
        // n'utilisent QUE l'égalité : l'opérateur `in` reste brut).
        const equalityOnly = op === "==";
        const runQuery = (limit?: number) => {
          firestoreState.ops.push({ kind: "query", path: describe });
          if (firestoreState.failWith) throw firestoreState.failWith;
          let results = firestoreState.queryResults;
          if (equalityOnly) {
            results = results.filter((doc) => String(doc[field]) === String(value));
          }
          if (limit) results = results.slice(0, limit);
          return {
            docs: results.map((data, index) => ({ id: `q${index}`, data: () => data })),
            size: results.length,
          };
        };
        return {
          get: async () => runQuery(),
          limit: (n: number) => ({ get: async () => runQuery(n) }),
        };
      },
    }),
  },
}));

// ---------------------------------------------------------------------------
// État hoisted — client Supabase factice chaînable
// ---------------------------------------------------------------------------

const supabaseState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  ops: [] as Array<{ op: string; args?: unknown }>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: vi.fn(() => supabaseFake()),
}));

function supabaseFake() {
  const rows = supabaseState.rows;
  const ops = supabaseState.ops;

  function matchesFilters(row: Record<string, unknown>, filters: Array<[string, string, unknown]>): boolean {
    return filters.every(([column, , expected]) => {
      if (column.startsWith("payload->>")) {
        const field = column.slice("payload->>".length);
        return String((row.payload as Record<string, unknown> | undefined)?.[field]) === String(expected);
      }
      return row[column] === expected;
    });
  }

  function queryBuilder(_table: string) {
    const filters: Array<[string, string, unknown]> = [];
    let orderColumn: string | null = null;
    let ascending = true;
    let limit: number | null = null;
    const builder = {
      eq: (column: string, value: unknown) => {
        filters.push([column, "eq", value]);
        ops.push({ op: "eq", args: [column, value] });
        return builder;
      },
      filter: (column: string, operator: string, value: unknown) => {
        filters.push([column, operator, value]);
        ops.push({ op: "filter", args: [column, operator, value] });
        return builder;
      },
      order: (column: string, opts?: { ascending?: boolean }) => {
        orderColumn = column;
        ascending = opts?.ascending ?? true;
        ops.push({ op: "order", args: [column, opts] });
        return builder;
      },
      limit: (n: number) => {
        limit = n;
        ops.push({ op: "limit", args: n });
        return builder;
      },
      maybeSingle: async () => {
        ops.push({ op: "maybeSingle" });
        const match = rows.find((row) => matchesFilters(row, filters));
        return { data: match ?? null, error: null };
      },
      then: (
        resolve: (value: unknown) => void,
        _reject?: (reason?: unknown) => void,
      ) => {
        ops.push({ op: "select-run", args: { orderColumn, limit } });
        let results = rows.filter((row) => matchesFilters(row, filters));
        if (orderColumn) {
          const field = orderColumn.startsWith("payload->>") ? orderColumn.slice("payload->>".length) : null;
          results = [...results].sort((left, right) => {
            if (!field) return 0;
            const leftValue = (left.payload as Record<string, unknown>)?.[field];
            const rightValue = (right.payload as Record<string, unknown>)?.[field];
            return ascending ? String(leftValue).localeCompare(String(rightValue)) : String(rightValue).localeCompare(String(leftValue));
          });
        }
        if (limit !== null) results = results.slice(0, limit);
        resolve({ data: results, error: null });
      },
    };
    return builder;
  }

  return {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        ops.push({ op: "insert", args: row });
        // Le vrai Supabase PERSISTE la ligne : elle est relisible par select
        // (un agent créé sous quota doit être retrouvé depuis le miroir).
        rows.push(row);
        return { then: (resolve: (value: unknown) => void) => resolve({ data: null, error: null }) };
      },
      upsert: (row: Record<string, unknown>, opts?: unknown) => {
        ops.push({ op: "upsert", args: row, opts });
        return { then: (resolve: (value: unknown) => void) => resolve({ data: null, error: null }) };
      },
      select: (columns: string, opts?: unknown) => {
        ops.push({ op: "select", args: [columns, opts] });
        return queryBuilder(table);
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock de la politique d'accès multi-tenant (dépôt = appelant isolé)
// ---------------------------------------------------------------------------

const accessState = vi.hoisted(() => ({
  listUserOrgIds: vi.fn<(uid: string) => Promise<string[]>>(),
  assertResourceRead: vi.fn<(uid: string, ref: { ownerId: string; orgId?: string | null }) => Promise<unknown>>(),
}));

vi.mock("@/lib/tenants/resource-access", () => ({
  assertOrgAttach: vi.fn(async () => undefined),
  assertOrgTransfer: vi.fn(async () => undefined),
  assertResourceWrite: vi.fn(async () => undefined),
  assertResourceRead: accessState.assertResourceRead,
  listUserOrgIds: accessState.listUserOrgIds,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { resetQuotaGuardForTests } from "@/lib/db/quota-guard";

import {
  createAgentRecord,
  getAgentById,
  getAgentForOwner,
  getAgentForUser,
  listAgentsByOwner,
  listAgentsForUser,
} from "./repository";

function quotaError(message = "Resource has been exhausted (e.g., check quota)."): Error {
  return Object.assign(new Error(message), { code: 8 });
}

const validInput = {
  name: "Agent Test",
  description: "Agent de test résilient",
  type: "universal" as const,
  skills: ["Analyse"],
  systemPrompt: "Agent Gen3ia de test avec un prompt suffisamment long.",
};

function resetAll(): void {
  firestoreState.docs.clear();
  firestoreState.ops.length = 0;
  firestoreState.failWith = null;
  firestoreState.queryResults = [];
  supabaseState.rows = [];
  supabaseState.ops.length = 0;
  resetQuotaGuardForTests();
  accessState.listUserOrgIds.mockReset();
  accessState.assertResourceRead.mockReset();
  // Défauts : l'appelant est le propriétaire (lecture personnelle sans Firestore).
  accessState.assertResourceRead.mockImplementation(async (_uid: string, ref: { ownerId: string }) => {
    if (ref.ownerId !== _uid) throw new Error("Ressource introuvable ou accès refusé.");
    return { read: true, write: true, via: "owner" };
  });
  accessState.listUserOrgIds.mockResolvedValue([]);
}

beforeEach(() => {
  resetAll();
});

// ---------------------------------------------------------------------------
// createAgentRecord
// ---------------------------------------------------------------------------

describe("createAgentRecord résilient (Task 96-c)", () => {
  it("nominal : agent créé dans Firestore ET mirroir, ownerId explicite, createdAt en Date", async () => {
    const record = await createAgentRecord("user-1", validInput);
    expect(record.id).toBe("new-agent-id");
    expect(record.ownerId).toBe("user-1");
    const creates = firestoreState.ops.filter((op) => op.kind === "create");
    expect(creates).toHaveLength(1);
    const payload = creates[0]!.payload as Record<string, unknown>;
    expect(payload.createdAt).toBeInstanceOf(Date);
    expect(payload.ownerId).toBe("user-1");
    const mirror = supabaseState.ops.filter((op) => op.op === "upsert");
    expect(mirror).toHaveLength(1);
    expect((mirror[0]!.args as Record<string, unknown>).owner_id).toBe("user-1");
  });

  it("sous quota : l'agent est créé sur le MIROIR seul (section Agent IA utilisable)", async () => {
    firestoreState.failWith = quotaError();
    const record = await createAgentRecord("user-1", validInput);
    expect(record.id).toBe("new-agent-id");
    expect(record.name).toBe("Agent Test");
    const inserts = supabaseState.ops.filter((op) => op.op === "insert");
    expect(inserts).toHaveLength(1);
    const row = inserts[0]!.args as Record<string, unknown>;
    expect(row.collection).toBe("agents");
    expect(row.owner_id).toBe("user-1");
    expect((row.payload as Record<string, unknown>).systemPrompt).toBe(validInput.systemPrompt);
  });

  it("l'agent créé est relisible depuis le miroir par getAgentForUser", async () => {
    firestoreState.failWith = quotaError();
    const created = await createAgentRecord("user-1", validInput);
    const record = await getAgentForUser("user-1", created.id);
    expect(record?.id).toBe(created.id);
    expect(record?.ownerId).toBe("user-1");
  });
});

// ---------------------------------------------------------------------------
// listAgentsByOwner / listAgentsForUser
// ---------------------------------------------------------------------------

describe("listAgentsByOwner résiliente (Task 96-c)", () => {
  it("nominal : scan égalité + tri mémoire createdAt desc + filtres archived/projet", async () => {
    firestoreState.queryResults = [
      { id: "ignored", ownerId: "user-1", name: "Vieux", status: "active", createdAt: new Date("2026-01-01T00:00:00Z") },
      { ownerId: "user-1", name: "Archivé", status: "archived", createdAt: new Date("2026-01-04T00:00:00Z") },
      { ownerId: "user-1", name: "Récent", status: "active", createdAt: new Date("2026-01-03T00:00:00Z") },
      { ownerId: "user-2", name: "Autre", status: "active", createdAt: new Date("2026-01-05T00:00:00Z") },
    ];
    const list = await listAgentsByOwner("user-1");
    expect(list.map((a) => a.name)).toEqual(["Récent", "Vieux"]);
    expect(list.every((a) => a.id.length > 0)).toBe(true);
  });

  it("sous quota : lit le miroir (filtre payload->>ownerId)", async () => {
    firestoreState.failWith = quotaError();
    supabaseState.rows = [
      { collection: "agents", document_id: "a1", owner_id: "user-1", payload: { ownerId: "user-1", name: "Miroir", status: "active", createdAt: "2026-01-02T00:00:00.000Z" } },
      { collection: "agents", document_id: "a2", owner_id: "user-2", payload: { ownerId: "user-2", name: "Autre", status: "active", createdAt: "2026-01-03T00:00:00.000Z" } },
    ];
    const list = await listAgentsByOwner("user-1");
    expect(list.map((a) => a.name)).toEqual(["Miroir"]);
    expect(list[0]!.id).toBe("a1");
  });

  it("plus de LIST_CAP candidats : slice mémoire à 100", async () => {
    firestoreState.queryResults = Array.from({ length: 120 }, (_, index) => ({
      ownerId: "user-1",
      name: `Agent ${index + 1}`,
      status: "active",
      createdAt: new Date(Date.UTC(2026, 0, 1, index)),
    }));
    const list = await listAgentsByOwner("user-1");
    expect(list).toHaveLength(100);
    expect(list[0]!.name).toBe("Agent 120");
  });
});

describe("listAgentsForUser fail-soft (Task 96-c)", () => {
  it("listUserOrgIds en erreur quota → repli sur les agents personnels SEULS (pas de 500)", async () => {
    accessState.listUserOrgIds.mockRejectedValue(quotaError());
    firestoreState.queryResults = [
      { ownerId: "user-1", name: "Perso", status: "active", createdAt: new Date("2026-01-01T00:00:00Z") },
    ];
    const list = await listAgentsForUser("user-1");
    expect(list.map((a) => a.name)).toEqual(["Perso"]);
  });

  it("sans org : agents personnels uniquement", async () => {
    accessState.listUserOrgIds.mockResolvedValue([]);
    firestoreState.queryResults = [
      { ownerId: "user-1", name: "Perso", status: "active", createdAt: new Date("2026-01-01T00:00:00Z") },
    ];
    const list = await listAgentsForUser("user-1");
    expect(list).toHaveLength(1);
  });

  it("orgs saines : union personnels + org, dédupliquée, triée createdAt desc", async () => {
    accessState.listUserOrgIds.mockResolvedValue(["org-1"]);
    firestoreState.queryResults = [
      { ownerId: "user-1", name: "Perso", status: "active", createdAt: new Date("2026-01-01T00:00:00Z") },
    ];
    // La requête orgId-in est simulée par un second jeu de résultats (le fake
    // renvoie queryResults pour TOUTES les requêtes) : l'agent « Perso » est
    // déjà dédupliqué par id.
    const list = await listAgentsForUser("user-1");
    expect(list.map((a) => a.name)).toEqual(["Perso"]);
  });

  it("requête org en erreur → fail-soft sur les agents personnels", async () => {
    accessState.listUserOrgIds.mockResolvedValue(["org-1"]);
    firestoreState.failWith = quotaError();
    // listAgentsByOwner basculera sur le miroir (vide) ; la requête orgId-in
    // échouera aussi → repli personnel (liste vide mais PAS d'exception).
    const list = await listAgentsForUser("user-1");
    expect(Array.isArray(list)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getAgentById / getAgentForOwner / getAgentForUser
// ---------------------------------------------------------------------------

describe("lectures unitaires résilientes (Task 96-c)", () => {
  it("getAgentById : agent actif lu depuis le miroir ; statut non actif → null", async () => {
    supabaseState.rows = [
      { collection: "agents", document_id: "a1", owner_id: "user-1", payload: { ownerId: "user-1", name: "Actif", status: "active", systemPrompt: "Prompt suffisamment long pour la charte." } },
      { collection: "agents", document_id: "a2", owner_id: "user-1", payload: { ownerId: "user-1", name: "Archivé", status: "archived", systemPrompt: "Prompt suffisamment long pour la charte." } },
    ];
    const active = await getAgentById("a1");
    expect(active?.name).toBe("Actif");
    expect(await getAgentById("a2")).toBeNull();
  });

  it("getAgentForOwner : garde d'ownership sur les données miroir", async () => {
    supabaseState.rows = [
      { collection: "agents", document_id: "a1", owner_id: "user-2", payload: { ownerId: "user-2", name: "Privé", status: "active", systemPrompt: "Prompt suffisamment long pour la charte." } },
    ];
    const r = await getAgentForOwner("user-2", "a1");
    expect(r?.name).toBe("Privé");
    expect(await getAgentForOwner("user-1", "a1")).toBeNull();
  });

  it("getAgentForUser : assertResourceRead consulté — dénégation → null", async () => {
    supabaseState.rows = [
      { collection: "agents", document_id: "a1", owner_id: "user-2", payload: { ownerId: "user-2", name: "Org", status: "active", systemPrompt: "Prompt suffisamment long pour la charte." } },
    ];
    const record = await getAgentForUser("user-3", "a1");
    expect(record).toBeNull();
    expect(accessState.assertResourceRead).toHaveBeenCalledWith("user-3", { ownerId: "user-2", orgId: null });
  });
});

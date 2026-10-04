import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 96-c — dépôt chat résilient : sous quota Firestore épuisé, la
 * création/lecture/append/suppression de conversations bascule sur le
 * miroir Supabase (firestore_fallback) sans jamais exposer la conversation
 * d'un autre utilisateur.
 *
 * Mocks (patterns dépôt) : adminDb factice via vi.mock("@/lib/firebase/admin")
 * (état hoisted, runTransaction/batch/where-chain), client Supabase chaînable
 * via vi.mock("@/lib/supabase/admin"), quota-guard RÉEL (reset par test) pour
 * valider l'intégration disjoncteur de bout en bout.
 */

// ---------------------------------------------------------------------------
// État hoisted — Firestore factice
// ---------------------------------------------------------------------------

const firestoreState = vi.hoisted(() => ({
  docs: new Map<string, { exists: boolean; data?: Record<string, unknown> }>(),
  ops: [] as Array<{ kind: string; path: string; payload?: unknown }>,
  /** Quand défini, chaque get/set/create/delete/runTransaction lève (quota…). */
  failWith: null as unknown,
  queryResults: [] as Array<Record<string, unknown>>,
  txSet: [] as Array<{ path: string; payload: unknown }>,
  txUpdate: [] as Array<{ path: string; payload: unknown }>,
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => ({
      // doc() SANS argument : génération locale d'identifiant (aucune I/O).
      doc: (id?: string) => {
        if (id === undefined) {
          return { id: name === "chatMessages" ? "new-msg-id" : "new-conv-id" };
        }
        const path = `${name}/${id}`;
        const throwIfFailing = () => {
          if (firestoreState.failWith) throw firestoreState.failWith;
        };
        return {
          get: async () => {
            firestoreState.ops.push({ kind: "get", path });
            throwIfFailing();
            const doc = firestoreState.docs.get(path);
            if (!doc?.exists) return { exists: false, data: () => undefined };
            return { exists: true, data: () => doc.data };
          },
          set: async (payload: unknown) => {
            firestoreState.ops.push({ kind: "set", path, payload });
            throwIfFailing();
            firestoreState.docs.set(path, { exists: true, data: payload as Record<string, unknown> });
            return {};
          },
          create: async (payload: unknown) => {
            firestoreState.ops.push({ kind: "create", path, payload });
            throwIfFailing();
            firestoreState.docs.set(path, { exists: true, data: payload as Record<string, unknown> });
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
      where: (field: string, _op: string, value: unknown) => {
        const describe = `${name}?${field}==${String(value)}`;
        const runQuery = (limit?: number) => {
          firestoreState.ops.push({ kind: "query", path: describe });
          if (firestoreState.failWith) throw firestoreState.failWith;
          const results = limit ? firestoreState.queryResults.slice(0, limit) : firestoreState.queryResults;
          return {
            docs: results.map((data, index) => ({ id: `q${index}`, data: () => data, ref: { id: `q${index}`, path: `q${index}` } })),
            size: results.length,
          };
        };
        return {
          get: async () => runQuery(),
          where: () => ({
            get: async () => runQuery(),
            limit: (n: number) => ({ get: async () => runQuery(n) }),
          }),
          limit: (n: number) => ({ get: async () => runQuery(n) }),
        };
      },
    }),
    runTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      if (firestoreState.failWith) throw firestoreState.failWith;
      return fn({
        get: async () => {
          const doc = firestoreState.docs.get("chatConversations/conv-1");
          if (!doc?.exists) return { exists: false, data: () => undefined };
          return { exists: true, data: () => doc.data };
        },
        set: (ref: { id: string }, payload: unknown) => firestoreState.txSet.push({ path: `chatMessages/${ref.id}`, payload }),
        update: (ref: unknown, payload: unknown) => firestoreState.txUpdate.push({ path: String(ref), payload }),
      });
    }),
    batch: () => ({
      delete: (ref: { path: string }) => firestoreState.ops.push({ kind: "batch-delete", path: ref.path }),
      commit: async () => {
        if (firestoreState.failWith) throw firestoreState.failWith;
        return {};
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
        // Le vrai Supabase PERSISTE la ligne (relisible par select).
        rows.push(row);
        return { then: (resolve: (value: unknown) => void) => resolve({ data: null, error: null }) };
      },
      upsert: (row: Record<string, unknown>, opts?: unknown) => {
        ops.push({ op: "upsert", args: row, opts });
        return { then: (resolve: (value: unknown) => void) => resolve({ data: null, error: null }) };
      },
      delete: () => {
        ops.push({ op: "delete" });
        const deleteFilters: Array<[string, string, unknown]> = [];
        const deleteBuilder = {
          eq: (column: string, value: unknown) => {
            deleteFilters.push([column, "eq", value]);
            return deleteBuilder;
          },
          then: (resolve: (value: unknown) => void) => {
            const kept = rows.filter((row) => !matchesFilters(row, deleteFilters));
            rows.length = 0;
            rows.push(...kept);
            resolve({ data: null, error: null });
          },
        };
        return deleteBuilder;
      },
      select: (columns: string, opts?: unknown) => {
        ops.push({ op: "select", args: [columns, opts] });
        return queryBuilder(table);
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock de l'index vectoriel (jamais de réseau dans les tests)
// ---------------------------------------------------------------------------

vi.mock("@/lib/chat/vector-index", () => ({
  indexConversationMessage: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { resetQuotaGuardForTests, noteFirestoreQuotaError } from "@/lib/db/quota-guard";
import {
  appendMessage,
  createConversation,
  deleteConversation,
  findLatestConversation,
  getConversation,
  listConversations,
} from "./repository";
import { indexConversationMessage } from "@/lib/chat/vector-index";
import { adminDb } from "@/lib/firebase/admin";

function quotaError(message = "Resource has been exhausted (e.g., check quota)."): Error {
  return Object.assign(new Error(message), { code: 8 });
}

function transientError(): Error {
  return Object.assign(new Error("The service is currently unavailable."), { code: 14 });
}

function openBreaker(): void {
  for (let i = 0; i < 3; i += 1) noteFirestoreQuotaError(quotaError("Quota exceeded."));
}

function resetAll(): void {
  firestoreState.docs.clear();
  firestoreState.ops.length = 0;
  firestoreState.failWith = null;
  firestoreState.queryResults = [];
  firestoreState.txSet.length = 0;
  firestoreState.txUpdate.length = 0;
  supabaseState.rows = [];
  supabaseState.ops.length = 0;
  resetQuotaGuardForTests();
  vi.mocked(adminDb.runTransaction).mockClear();
}

beforeEach(() => {
  resetAll();
});

// ---------------------------------------------------------------------------
// appendMessage
// ---------------------------------------------------------------------------

describe("appendMessage (Task 96-c)", () => {
  const input = {
    conversationId: "conv-1",
    userId: "user-1",
    role: "user" as const,
    content: "Bonjour",
  };

  it("nominal : transaction Firestore conservée (message + compteur), createdAt en Date", async () => {
    firestoreState.docs.set("chatConversations/conv-1", {
      exists: true,
      data: { userId: "user-1", messageCount: 2, projectId: "proj-1" },
    });
    const saved = await appendMessage(input);
    expect(firestoreState.txSet).toHaveLength(1);
    const messagePayload = firestoreState.txSet[0]!.payload as Record<string, unknown>;
    expect(messagePayload.createdAt).toBeInstanceOf(Date);
    expect(messagePayload.generationStatus).toBe("complete");
    // serverTimestamp INTERDIT : le compteur part en Date (tri miroir exploitable).
    const conversationUpdate = firestoreState.txUpdate[0]!.payload as Record<string, unknown>;
    expect(conversationUpdate.messageCount).toBe(3);
    expect(conversationUpdate.updatedAt).toBeInstanceOf(Date);
    expect(saved.id).toBe("new-msg-id");
    expect(saved.createdAt).not.toBe("");
    expect(indexConversationMessage).toHaveBeenCalled();
  });

  it("sous quota : décomposition résiliente — message créé + compteur incrémenté sur le miroir", async () => {
    firestoreState.failWith = quotaError();
    supabaseState.rows = [
      {
        collection: "chatConversations",
        document_id: "conv-1",
        owner_id: "user-1",
        payload: { userId: "user-1", messageCount: 2, projectId: "proj-1", updatedAt: "2026-01-01T00:00:00.000Z" },
      },
    ];
    const saved = await appendMessage(input);
    expect(saved.id).toBe("new-msg-id");
    const inserts = supabaseState.ops.filter((op) => op.op === "insert");
    expect(inserts).toHaveLength(1);
    const insertRow = inserts[0]!.args as Record<string, unknown>;
    expect(insertRow.collection).toBe("chatMessages");
    expect(insertRow.document_id).toBe("new-msg-id");
    expect(insertRow.owner_id).toBe("user-1");
    const upserts = supabaseState.ops.filter((op) => op.op === "upsert");
    expect(upserts).toHaveLength(1);
    const upsertRow = upserts[0]!.args as Record<string, unknown>;
    expect(upsertRow.document_id).toBe("conv-1");
    // FieldValue.increment(1) RÉSOLU côté miroir : 2 + 1 = 3 (jamais un objet opaque).
    expect((upsertRow.payload as Record<string, unknown>).messageCount).toBe(3);
    expect(indexConversationMessage).toHaveBeenCalled();
    expect((indexConversationMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ projectId: "proj-1" });
  });

  it("sous quota + conversation d'un AUTRE utilisateur → 'Conversation introuvable.'", async () => {
    firestoreState.failWith = quotaError();
    supabaseState.rows = [
      {
        collection: "chatConversations",
        document_id: "conv-1",
        owner_id: "user-2",
        payload: { userId: "user-2", messageCount: 2 },
      },
    ];
    await expect(appendMessage(input)).rejects.toThrow("Conversation introuvable.");
    expect(supabaseState.ops.filter((op) => op.op === "insert")).toHaveLength(0);
  });

  it("disjoncteur ouvert : repli direct, runTransaction JAMAIS appelé", async () => {
    openBreaker();
    supabaseState.rows = [
      {
        collection: "chatConversations",
        document_id: "conv-1",
        owner_id: "user-1",
        payload: { userId: "user-1", messageCount: 0 },
      },
    ];
    const saved = await appendMessage(input);
    expect(saved.id).toBe("new-msg-id");
    expect(vi.mocked(adminDb.runTransaction)).not.toHaveBeenCalled();
    expect(firestoreState.txSet).toHaveLength(0);
    expect(supabaseState.ops.filter((op) => op.op === "insert")).toHaveLength(1);
  });

  it("incident TRANSITOIRE : rejeté tel quel (comportement historique), zéro repli", async () => {
    firestoreState.failWith = transientError();
    await expect(appendMessage(input)).rejects.toThrow("currently unavailable");
    expect(supabaseState.ops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createConversation / getConversation
// ---------------------------------------------------------------------------

describe("createConversation + getConversation (Task 96-c)", () => {
  it("crée la conversation dans Firestore ET le miroir (ownerId explicite, Date)", async () => {
    const conversation = await createConversation("user-1", "Nouvelle conversation", { agentId: "agent-1" });
    expect(conversation.id).toBe("new-conv-id");
    const creates = firestoreState.ops.filter((op) => op.kind === "create");
    expect(creates).toHaveLength(1);
    expect((creates[0]!.payload as Record<string, unknown>).createdAt).toBeInstanceOf(Date);
    const mirrors = supabaseState.ops.filter((op) => op.op === "upsert");
    expect(mirrors).toHaveLength(1);
    expect((mirrors[0]!.args as Record<string, unknown>).owner_id).toBe("user-1");
  });

  it("sous quota : la conversation est créée sur le miroir seul", async () => {
    firestoreState.failWith = quotaError();
    const conversation = await createConversation("user-1");
    expect(conversation.id).toBe("new-conv-id");
    const inserts = supabaseState.ops.filter((op) => op.op === "insert");
    expect(inserts).toHaveLength(1);
    expect(firestoreState.ops.filter((op) => op.kind === "create").every((op) => op.path.includes("new-conv-id"))).toBe(true);
  });

  it("getConversation : garde d'ownership — la conversation d'autrui est null (miroir)", async () => {
    supabaseState.rows = [
      { collection: "chatConversations", document_id: "conv-9", owner_id: "user-2", payload: { userId: "user-2", title: "Fil privé" } },
    ];
    const owned = await getConversation("user-2", "conv-9");
    expect(owned?.title).toBe("Fil privé");
    const intruder = await getConversation("user-1", "conv-9");
    expect(intruder).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listConversations / findLatestConversation
// ---------------------------------------------------------------------------

describe("listConversations résiliente (Task 96-c)", () => {
  it("nominal : filtres égalité + tri mémoire updatedAt desc + ids injectés", async () => {
    firestoreState.queryResults = [
      { userId: "user-1", agentId: "agent-1", title: "Ancien", updatedAt: new Date("2026-01-01T00:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z") },
      { userId: "user-1", agentId: "agent-1", title: "Récent", updatedAt: new Date("2026-01-03T00:00:00Z"), createdAt: new Date("2026-01-03T00:00:00Z") },
      { userId: "user-1", agentId: "agent-1", title: "Moyen", updatedAt: new Date("2026-01-02T00:00:00Z"), createdAt: new Date("2026-01-02T00:00:00Z") },
    ];
    const list = await listConversations("user-1", 50, { agentId: "agent-1" });
    expect(list.map((c) => c.title)).toEqual(["Récent", "Moyen", "Ancien"]);
    expect(list.every((c) => typeof c.id === "string" && c.id.length > 0)).toBe(true);
  });

  it("sous quota : lit le miroir (filtres payload->> + tri côté secours)", async () => {
    firestoreState.failWith = quotaError();
    supabaseState.rows = [
      { collection: "chatConversations", document_id: "c1", owner_id: "user-1", payload: { userId: "user-1", agentId: "agent-1", title: "Miroir récent", updatedAt: "2026-01-05T00:00:00.000Z" } },
      { collection: "chatConversations", document_id: "c2", owner_id: "user-1", payload: { userId: "user-1", agentId: "agent-1", title: "Miroir ancien", updatedAt: "2026-01-04T00:00:00.000Z" } },
      { collection: "chatConversations", document_id: "c3", owner_id: "user-2", payload: { userId: "user-2", agentId: "agent-1", title: "Autre utilisateur", updatedAt: "2026-01-06T00:00:00.000Z" } },
    ];
    const list = await listConversations("user-1", 50, { agentId: "agent-1" });
    expect(list.map((c) => c.title)).toEqual(["Miroir récent", "Miroir ancien"]);
    expect(list.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});

describe("findLatestConversation résiliente (Task 96-c)", () => {
  it("renvoie la plus récente par updatedAt (tri mémoire après scan borné)", async () => {
    firestoreState.queryResults = [
      { userId: "user-1", title: "Ancienne", updatedAt: new Date("2026-01-01T00:00:00Z") },
      { userId: "user-1", title: "Dernière", updatedAt: new Date("2026-01-09T00:00:00Z") },
    ];
    const latest = await findLatestConversation("user-1");
    expect(latest?.title).toBe("Dernière");
  });
});

// ---------------------------------------------------------------------------
// deleteConversation
// ---------------------------------------------------------------------------

describe("deleteConversation résiliente (Task 96-c)", () => {
  it("nominal : messages purgés (batch) + conversation supprimée de Firestore ET du miroir", async () => {
    firestoreState.docs.set("chatConversations/conv-1", { exists: true, data: { userId: "user-1", title: "Fil" } });
    firestoreState.queryResults = [{ conversationId: "conv-1", role: "user" }];
    supabaseState.rows = [
      { collection: "chatConversations", document_id: "conv-1", owner_id: "user-1", payload: { userId: "user-1" } },
    ];
    await deleteConversation("user-1", "conv-1");
    expect(firestoreState.ops.some((op) => op.kind === "batch-delete")).toBe(true);
    expect(firestoreState.ops.some((op) => op.kind === "delete" && op.path === "chatConversations/conv-1")).toBe(true);
    expect(supabaseState.rows).toHaveLength(0);
  });

  it("sous quota : messages orphelins tolérés, conversation retirée du MIROIR (vue utilisateur)", async () => {
    firestoreState.failWith = quotaError();
    supabaseState.rows = [
      { collection: "chatConversations", document_id: "conv-1", owner_id: "user-1", payload: { userId: "user-1", title: "Fil" } },
      { collection: "chatMessages", document_id: "m1", owner_id: "user-1", payload: { conversationId: "conv-1" } },
    ];
    await deleteConversation("user-1", "conv-1");
    const remaining = supabaseState.rows.filter((row) => row.collection === "chatConversations");
    expect(remaining).toHaveLength(0);
  });

  it("conversation d'autrui → 'Conversation introuvable.', rien n'est supprimé", async () => {
    supabaseState.rows = [
      { collection: "chatConversations", document_id: "conv-1", owner_id: "user-2", payload: { userId: "user-2" } },
    ];
    await expect(deleteConversation("user-1", "conv-1")).rejects.toThrow("Conversation introuvable.");
    expect(supabaseState.rows).toHaveLength(1);
  });
});

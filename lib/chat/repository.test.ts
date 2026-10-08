import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 96-c — dépôt chat résilient (adapté Task 108) : écritures bornées
 * (deadline anti-stall + disjoncteur quota, lib/db/firestore-resilient) et
 * chemin décomposé de appendMessage (get + create + set merge) servant de
 * sonde half-open. Task 108 : le second backend a été supprimé — sous quota
 * RÉEL, l'erreur quota-classifiée est rejetée (503 actionnable côté routes),
 * il n'y a plus de miroir.
 *
 * Mocks (patterns dépôt) : adminDb factice via vi.mock("@/lib/firebase/admin")
 * (état hoisted, runTransaction/batch/where-chain), quota-guard RÉEL (reset
 * par test) pour valider l'intégration disjoncteur de bout en bout.
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

/**
 * Comparateur de tri SERVEUR simulé (Task 101) : émule l'ordre renvoyé par
 * Firestore quand orderBy est posé (Date, toMillis, ISO, nombre, chaîne).
 */
function valeurServeur(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "object" && value !== null && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    try {
      return (value as { toMillis: () => number }).toMillis();
    } catch {
      return null;
    }
  }
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function compareServeur(left: Record<string, unknown>, right: Record<string, unknown>, field: string): number {
  const ln = valeurServeur(left[field]);
  const rn = valeurServeur(right[field]);
  if (ln !== null && rn !== null) return ln - rn;
  const ls = String(left[field] ?? "");
  const rs = String(right[field] ?? "");
  return ls < rs ? -1 : ls > rs ? 1 : 0;
}

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
        // Task 101 : chaîne complète where → orderBy → limit → get (le tri
        // SERVEUR est émulé : les résultats sont ordonnés AVANT la limite,
        // comme le vrai Firestore avec ses index composites).
        const state: { order: { field: string; dir: "asc" | "desc" } | null; limit: number | undefined } = {
          order: null,
          limit: undefined,
        };
        const runQuery = () => {
          firestoreState.ops.push({ kind: "query", path: describe, opts: { order: state.order ? { ...state.order } : null, limit: state.limit ?? null } });
          if (firestoreState.failWith) throw firestoreState.failWith;
          let results = firestoreState.queryResults.map((data) => ({
            data: () => data as Record<string, unknown>,
          }));
          if (state.order) {
            const order = state.order;
            results.sort((left, right) => {
              const cmp = compareServeur(left.data(), right.data(), order.field);
              return order.dir === "desc" ? -cmp : cmp;
            });
          }
          if (state.limit !== undefined) results = results.slice(0, state.limit);
          return {
            docs: results.map((entry, index) => ({
              id: `q${index}`,
              data: () => entry.data(),
              ref: { id: `q${index}`, path: `q${index}` },
            })),
            size: results.length,
          };
        };
        const builder = {
          where: () => builder,
          orderBy: (orderField: string, dir: "asc" | "desc" = "asc") => {
            state.order = { field: orderField, dir };
            return builder;
          },
          limit: (n: number) => {
            state.limit = n;
            return builder;
          },
          get: async () => runQuery(),
        };
        return builder;
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
    // serverTimestamp INTERDIT : le compteur part en Date (tri mémoire exploitable).
    const conversationUpdate = firestoreState.txUpdate[0]!.payload as Record<string, unknown>;
    expect(conversationUpdate.messageCount).toBe(3);
    expect(conversationUpdate.updatedAt).toBeInstanceOf(Date);
    expect(saved.id).toBe("new-msg-id");
    expect(saved.createdAt).not.toBe("");
    expect(indexConversationMessage).toHaveBeenCalled();
  });

  it("sous quota : erreur quota-classifiée rejetée (pas de message silencieusement perdu)", async () => {
    firestoreState.failWith = quotaError();
    await expect(appendMessage(input)).rejects.toThrow(/quota|Quota|exhausted/);
  });

  it("disjoncteur ouvert : runTransaction JAMAIS appelé, erreur quota rejetée", async () => {
    openBreaker();
    await expect(appendMessage(input)).rejects.toThrow(/quota/);
    expect(vi.mocked(adminDb.runTransaction)).not.toHaveBeenCalled();
    expect(firestoreState.txSet).toHaveLength(0);
  });

  it("incident TRANSITOIRE : rejeté tel quel (comportement historique)", async () => {
    firestoreState.failWith = transientError();
    await expect(appendMessage(input)).rejects.toThrow("currently unavailable");
  });
});

// ---------------------------------------------------------------------------
// createConversation / getConversation
// ---------------------------------------------------------------------------

describe("createConversation + getConversation (Task 96-c)", () => {
  it("crée la conversation dans Firestore (ownerId, createdAt en Date)", async () => {
    const conversation = await createConversation("user-1", "Nouvelle conversation", { agentId: "agent-1" });
    expect(conversation.id).toBe("new-conv-id");
    const creates = firestoreState.ops.filter((op) => op.kind === "create");
    expect(creates).toHaveLength(1);
    expect((creates[0]!.payload as Record<string, unknown>).createdAt).toBeInstanceOf(Date);
    expect((creates[0]!.payload as Record<string, unknown>).agentId).toBe("agent-1");
  });

  it("sous quota : l'erreur est rejetée (Task 108 — plus de repli secondaire)", async () => {
    firestoreState.failWith = quotaError();
    await expect(createConversation("user-1")).rejects.toThrow(/quota|Quota|exhausted/);
  });

  it("getConversation : garde d'ownership — la conversation d'autrui est null", async () => {
    firestoreState.docs.set("chatConversations/conv-9", {
      exists: true,
      data: { userId: "user-2", title: "Fil privé" },
    });
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

  it("sous quota : erreur quota-classifiée rejetée (503 côté route)", async () => {
    firestoreState.failWith = quotaError();
    await expect(listConversations("user-1", 50)).rejects.toThrow(/quota|Quota|exhausted/);
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
  it("nominal : messages purgés (batch) + conversation supprimée", async () => {
    firestoreState.docs.set("chatConversations/conv-1", { exists: true, data: { userId: "user-1", title: "Fil" } });
    firestoreState.queryResults = [{ conversationId: "conv-1", role: "user" }];
    await deleteConversation("user-1", "conv-1");
    expect(firestoreState.ops.some((op) => op.kind === "batch-delete")).toBe(true);
    expect(firestoreState.ops.some((op) => op.kind === "delete" && op.path === "chatConversations/conv-1")).toBe(true);
  });

  it("sous quota : la suppression est rejetée (conversation conservée, 503 côté route)", async () => {
    firestoreState.docs.set("chatConversations/conv-1", { exists: true, data: { userId: "user-1", title: "Fil" } });
    firestoreState.failWith = quotaError();
    await expect(deleteConversation("user-1", "conv-1")).rejects.toThrow(/quota|Quota|exhausted/);
  });

  it("conversation d'autrui → 'Conversation introuvable.', rien n'est supprimé", async () => {
    firestoreState.docs.set("chatConversations/conv-1", { exists: true, data: { userId: "user-2" } });
    await expect(deleteConversation("user-1", "conv-1")).rejects.toThrow("Conversation introuvable.");
  });
});

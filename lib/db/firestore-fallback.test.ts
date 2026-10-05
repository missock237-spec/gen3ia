import { beforeEach, describe, expect, it, vi } from "vitest";

import { FieldValue } from "firebase-admin/firestore";

/**
 * Tests de la couche résiliente Firestore→Supabase (Task 95-b).
 *
 * Couverture : intégration du disjoncteur dans chaque fonction résiliente
 * (court-circuit → repli, note succès, note quota), lectures miroir-first
 * quand le circuit est ouvert, assainissement des sentinelles Firestore
 * (VRAI SDK FieldValue + duck-typing legacy) avec résolution des
 * incréments sur la ligne miroir, resilientQuery (tri mémoire + cap),
 * réconciliation miroir→Firestore (skips, re-imbrication, arrêt sur quota).
 *
 * Mocks : adminDb (vi.mock "@/lib/firebase/admin", état hoisted) et client
 * Supabase chaînable enregistrant ses opérations — le module quota-guard
 * (disjoncteur) est utilisé RÉEL (reset entre tests) pour valider
 * l'intégration de bout en bout.
 */

// ---------------------------------------------------------------------------
// État hoisted — Firestore factice
// ---------------------------------------------------------------------------

const firestoreState = vi.hoisted(() => ({
  docs: new Map<string, { exists: boolean; data?: Record<string, unknown> }>(),
  ops: [] as Array<{ kind: string; path: string; payload?: unknown; opts?: unknown }>,
  /** Quand défini, chaque get/set/create lève cette erreur (quota, 429…). */
  failWith: null as unknown,
  /** Task 101 : quand défini, chaque requête TRIÉE (orderBy posé) lève cette
   * erreur — émulation FAILED_PRECONDITION « index composite manquant » (le
   * scan simple, sans orderBy, continue de passer comme le vrai Firestore). */
  failOrderedWith: null as unknown,
  /** Task 97 : quand vrai, chaque get/set/create NE RÉPOND JAMAIS (stall —
   * comportement réel observé sous quota quotidien épuisé). */
  hang: false,
  /** Résultats factices des requêtes where().get() / where().limit().get(). */
  queryResults: [] as Array<Record<string, unknown>>,
}));

/**
 * Comparateur de tri SERVEUR simulé (Task 101) : émule l'ordre renvoyé par
 * Firestore quand orderBy est posé (Timestamp-like toMillis, Date, ISO,
 * nombre, chaîne) — indispensable pour valider le limit exact et le repli
 * index manquant avec les mêmes données que le vrai service.
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
      doc: (id: string) => {
        const path = `${name}/${id}`;
        const throwIfFailing = () => {
          if (firestoreState.failWith) throw firestoreState.failWith;
        };
        const hangForever = <T>(value: T): Promise<T> =>
          firestoreState.hang ? new Promise<T>(() => {}) : Promise.resolve(value);
        return {
          create: async (payload: unknown) => {
            firestoreState.ops.push({ kind: "create", path, payload });
            throwIfFailing();
            if (firestoreState.hang) return hangForever({});
            firestoreState.docs.set(path, { exists: true, data: payload as Record<string, unknown> });
            return {};
          },
          delete: async () => {
            firestoreState.ops.push({ kind: "delete", path });
            throwIfFailing();
            if (firestoreState.hang) return hangForever({});
            firestoreState.docs.delete(path);
            return {};
          },
          set: async (payload: unknown, opts?: unknown) => {
            firestoreState.ops.push({ kind: "set", path, payload, opts });
            throwIfFailing();
            if (firestoreState.hang) return hangForever({});
            const existing = firestoreState.docs.get(path);
            const merge = (opts as { merge?: boolean } | undefined)?.merge === true;
            firestoreState.docs.set(path, {
              exists: true,
              data: merge ? { ...(existing?.data ?? {}), ...(payload as object) } : (payload as Record<string, unknown>),
            });
            return {};
          },
          get: async () => {
            firestoreState.ops.push({ kind: "get", path });
            throwIfFailing();
            if (firestoreState.hang) return hangForever({ exists: false, data: () => undefined });
            const doc = firestoreState.docs.get(path);
            if (!doc?.exists) return { exists: false, data: () => undefined };
            return { exists: true, data: () => doc.data };
          },
        };
      },
      where: (field: string, _op: string, value: unknown) => {
        const describe = `${name}?${field}==${String(value)}`;
        // Task 101 : chaîne complète where → orderBy → limit → get (le vrai
        // SDK porte le tri CÔTÉ Firestore ; le fake l'émule en triant les
        // résultats avant l'application de la limite).
        const state: { order: { field: string; dir: "asc" | "desc" } | null; limit: number | undefined } = {
          order: null,
          limit: undefined,
        };
        const runQuery = () => {
          firestoreState.ops.push({
            kind: state.limit !== undefined ? "whereLimit" : "where",
            path: describe,
            opts: { order: state.order ? { ...state.order } : null, limit: state.limit ?? null },
          });
          if (firestoreState.failOrderedWith && state.order) throw firestoreState.failOrderedWith;
          if (firestoreState.failWith) throw firestoreState.failWith;
          // (l'erreur « index manquant » est vérifiée AVANT le quota : la vraie
          // requête triée échoue AVANT d'atteindre le backend — le scan de
          // repli, lui, peut tomber sur le quota).
          let results = [...firestoreState.queryResults];
          if (state.order) {
            const order = state.order;
            results.sort((left, right) => {
              const cmp = compareServeur(left, right, order.field);
              return order.dir === "desc" ? -cmp : cmp;
            });
          }
          if (state.limit !== undefined) results = results.slice(0, state.limit);
          return {
            docs: results.map((data, index) => ({ id: `q${index}`, data: () => data })),
            size: results.length,
          };
        };
        const builder = {
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
  },
}));

// ---------------------------------------------------------------------------
// État hoisted — client Supabase factice chaînable
// ---------------------------------------------------------------------------

const supabaseState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  ops: [] as Array<{ op: string; args?: unknown }>,
  /** Erreurs injectables par opération. */
  upsertError: null as unknown,
  insertError: null as unknown,
  selectError: null as unknown,
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
      if (column === "updated_at" && typeof expected === "string") {
        return String(row.updated_at ?? "") > expected;
      }
      if (Array.isArray(expected)) return expected.includes(row[column]);
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
      gt: (column: string, value: unknown) => {
        filters.push([column, "gt", value]);
        ops.push({ op: "gt", args: [column, value] });
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        filters.push([column, "in", values]);
        ops.push({ op: "in", args: [column, values] });
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
        if (supabaseState.selectError) return { data: null, error: supabaseState.selectError };
        const match = rows.find((row) => matchesFilters(row, filters));
        return { data: match ?? null, error: null };
      },
      // Thenable : `await builder` exécute la requête select.
      then: (
        resolve: (value: unknown) => void,
        _reject?: (reason?: unknown) => void,
      ) => {
        ops.push({ op: "select-run", args: { orderColumn, limit } });
        if (supabaseState.selectError) {
          resolve({ data: null, error: supabaseState.selectError });
          return;
        }
        let results = rows.filter((row) => matchesFilters(row, filters));
        if (orderColumn) {
          const field = orderColumn.startsWith("payload->>") ? orderColumn.slice("payload->>".length) : null;
          results = [...results].sort((left, right) => {
            if (!field) return 0;
            const leftValue = (left.payload as Record<string, unknown>)?.[field];
            const rightValue = (right.payload as Record<string, unknown>)?.[field];
            const leftText = String(leftValue ?? "");
            const rightText = String(rightValue ?? "");
            return ascending ? (leftText < rightText ? -1 : 1) : leftText < rightText ? 1 : -1;
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
        return {
          then: (resolve: (value: unknown) => void) => resolve({ data: null, error: supabaseState.insertError ?? null }),
        };
      },
      upsert: (row: Record<string, unknown>, opts?: unknown) => {
        ops.push({ op: "upsert", args: row, opts });
        return {
          then: (resolve: (value: unknown) => void) => resolve({ data: null, error: supabaseState.upsertError ?? null }),
        };
      },
      delete: () => {
        ops.push({ op: "delete" });
        const deleteFilters: Array<[string, string, unknown]> = [];
        const deleteBuilder = {
          eq: (column: string, value: unknown) => {
            deleteFilters.push([column, "eq", value]);
            return deleteBuilder;
          },
          // Thenable : `await deleteBuilder` exécute la suppression.
          then: (resolve: (value: unknown) => void) => {
            const before = rows.length;
            const kept = rows.filter((row) => !matchesFilters(row, deleteFilters));
            rows.length = 0;
            rows.push(...kept);
            resolve({ data: null, error: null, removed: before - rows.length });
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
// Helpers de tests
// ---------------------------------------------------------------------------

function missingIndexError(): Error {
  // Forme canonique de l'échec FAILED_PRECONDITION « index composite
  // manquant » (code gRPC 9 + message Firebase Console).
  return Object.assign(
    new Error("The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/test/firestore/indexes"),
    { code: 9 },
  );
}

function quotaError(message = "Quota exceeded for quota group 'default'."): Error {
  return Object.assign(new Error(message), { code: 8 });
}

function transientError(): Error {
  return Object.assign(new Error("The service is currently unavailable."), { code: 14 });
}

function openBreaker(): void {
  // Le seuil d'ouverture est 3 : trois erreurs de quota consécutives RÉELLES
  // notées au garde (comme le ferait une rafale d'appels Firestore en panne).
  for (let i = 0; i < 3; i += 1) {
    noteFirestoreQuotaError(quotaError());
  }
}

/** Réinitialise tous les états (Firestore, Supabase, disjoncteur). */
function resetAll(): void {
  firestoreState.docs.clear();
  firestoreState.ops.length = 0;
  firestoreState.failWith = null;
  firestoreState.failOrderedWith = null;
  firestoreState.hang = false;
  firestoreState.queryResults = [];
  supabaseState.rows = [];
  supabaseState.ops.length = 0;
  supabaseState.upsertError = null;
  supabaseState.insertError = null;
  supabaseState.selectError = null;
  resetQuotaGuardForTests();
}

import { noteFirestoreQuotaError, resetQuotaGuardForTests } from "./quota-guard";
import { getQuotaGuardStats } from "./quota-guard";
import {
  DEFAULT_RECONCILE_COLLECTIONS,
  FIRESTORE_ATTEMPT_TIMEOUT_MS,
  isFirestoreMissingIndexError,
  reconcileFallbackToFirestore,
  resilientCreate,
  resilientDelete,
  resilientGet,
  resilientList,
  resilientListByPayloadField,
  resilientQuery,
  resilientSet,
  sanitizeMirrorPayload,
} from "./firestore-fallback";

beforeEach(() => {
  resetAll();
});

describe("intégration disjoncteur (fonctions résilientes)", () => {
  it("resilientGet : succès Firestore referme le circuit et retourne le doc", async () => {
    firestoreState.docs.set("videoRenderJobs/j1", { exists: true, data: { id: "j1", status: "queued" } });
    const result = await resilientGet<{ id: string }>("videoRenderJobs", "j1");
    expect(result?.id).toBe("j1");
    expect(supabaseState.ops.filter((op) => op.op === "upsert")).toHaveLength(0);
  });

  it("resilientGet : erreur quota → note le disjoncteur puis repli miroir", async () => {
    supabaseState.rows = [{ collection: "videoRenderJobs", document_id: "j1", payload: { id: "j1", status: "processing" } }];
    firestoreState.failWith = quotaError();
    const result = await resilientGet<{ id: string; status: string }>("videoRenderJobs", "j1");
    expect(result?.status).toBe("processing");
    expect(supabaseState.ops.some((op) => op.op === "maybeSingle")).toBe(true);
  });

  it("resilientGet : erreur transitoire → rejetée SANS repli ni disjoncteur", async () => {
    firestoreState.failWith = transientError();
    await expect(resilientGet("videoRenderJobs", "j1")).rejects.toThrow("currently unavailable");
    expect(supabaseState.ops.some((op) => op.op === "maybeSingle")).toBe(false);
  });

  it("resilientGet : erreur métier → rejetée telle quelle (pas de repli)", async () => {
    firestoreState.failWith = Object.assign(new Error("permission denied"), { code: 7 });
    await expect(resilientGet("videoRenderJobs", "j1")).rejects.toThrow("permission denied");
    expect(supabaseState.ops.some((op) => op.op === "maybeSingle")).toBe(false);
  });

  it("disjoncteur ouvert (3 erreurs consécutives) → lectures miroir-FIRST sans toucher Firestore", async () => {
    openBreaker();
    supabaseState.rows = [{ collection: "videoRenderJobs", document_id: "j1", payload: { id: "j1", status: "processing", progress: 42 } }];
    const result = await resilientGet<{ progress: number }>("videoRenderJobs", "j1");
    expect(result?.progress).toBe(42);
    expect(firestoreState.ops.some((op) => op.kind === "get")).toBe(false);
  });

  it("disjoncteur ouvert + Supabase absent → fallbackError (jamais de perte silencieuse)", async () => {
    openBreaker();
    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    vi.mocked(getSupabaseAdmin).mockReturnValueOnce(null);
    await expect(resilientSet("videoRenderJobs", "j1", { status: "queued" }, { merge: true })).rejects.toThrow(
      "Firestore quota atteinte et Supabase fallback indisponible.",
    );
  });

  it("resilientSet : erreur quota → upsert de repli avec owner_id résolu", async () => {
    firestoreState.failWith = quotaError();
    await resilientSet("videoProductionJobs", "p1", { id: "p1", userId: "u1", stage: "assets" }, { merge: true });
    const upserts = supabaseState.ops.filter((op) => op.op === "upsert");
    expect(upserts).toHaveLength(1);
    expect((upserts[0].args as Record<string, unknown>).document_id).toBe("p1");
    expect((upserts[0].args as Record<string, unknown>).owner_id).toBe("u1");
  });

  it("resilientCreate : succès + miroir best-effort appelé", async () => {
    await resilientCreate("videoRenderJobs", "j2", { id: "j2", userId: "u1" }, "u1");
    const upserts = supabaseState.ops.filter((op) => op.op === "upsert");
    expect(upserts).toHaveLength(1);
    expect(firestoreState.ops.some((op) => op.kind === "create")).toBe(true);
  });

  it("resilientList : erreur quota → repli par owner_id", async () => {
    supabaseState.rows = [
      { collection: "videoProjects", document_id: "a", owner_id: "u1", payload: { id: "a" } },
      { collection: "videoProjects", document_id: "b", owner_id: "u1", payload: { id: "b" } },
      { collection: "videoProjects", document_id: "c", owner_id: "u2", payload: { id: "c" } },
    ];
    firestoreState.failWith = quotaError();
    const list = await resilientList<{ id: string }>("videoProjects", "userId", "u1");
    expect(list.map((row) => row.id).sort()).toEqual(["a", "b"]);
  });
});

describe("sanitizeMirrorPayload (sentinelles Firestore)", () => {
  it("VRAI FieldValue.increment(3) → résolu sur la valeur miroir actuelle", async () => {
    // Ligne miroir existante : attempts = 5.
    supabaseState.rows = [
      { collection: "videoRenderJobs", document_id: "j3", owner_id: null, payload: { id: "j3", attempts: 5 } },
    ];
    await resilientSet("videoRenderJobs", "j3", { attempts: FieldValue.increment(3) }, { merge: true });
    const upsert = supabaseState.ops.find((op) => op.op === "upsert");
    expect(upsert).toBeDefined();
    const payload = (upsert!.args as Record<string, unknown>).payload as Record<string, unknown>;
    expect(payload.attempts).toBe(8); // 5 (miroir) + 3 (opérande réel)
  });

  it("VRAI FieldValue.delete() → clé DROPPÉE du miroir (merge)", async () => {
    supabaseState.rows = [
      { collection: "videoRenderJobs", document_id: "j4", owner_id: null, payload: { id: "j4", staleField: "x", status: "queued" } },
    ];
    await resilientSet("videoRenderJobs", "j4", { status: "processing", staleField: FieldValue.delete() }, { merge: true });
    const payload = (supabaseState.ops.find((op) => op.op === "upsert")!.args as Record<string, unknown>).payload as Record<string, unknown>;
    expect(payload.status).toBe("processing");
    expect("staleField" in payload).toBe(false);
  });

  it("VRAI FieldValue.serverTimestamp() → clé écartée (non sérialisable JSONB)", async () => {
    const { payload } = sanitizeMirrorPayload({ when: FieldValue.serverTimestamp(), keep: true });
    expect("when" in payload).toBe(false);
    expect(payload.keep).toBe(true);
  });

  it("duck-typing legacy (_methodName/_operand) toujours supporté (mocks)", () => {
    const { payload, mutated } = sanitizeMirrorPayload({
      n: { _methodName: "increment", _operand: 2 },
      gone: { _methodName: "delete" },
    });
    expect(mutated).toBe(true);
    expect("n" in payload).toBe(false);
    expect("gone" in payload).toBe(false);
  });

  it("payload sans sentinelle → non muté (identité conservée, zéro coût)", () => {
    const source = { id: "x", progress: 0.5 };
    const { payload, mutated } = sanitizeMirrorPayload(source);
    expect(mutated).toBe(false);
    expect(payload).toBe(source as unknown as Record<string, unknown>);
  });

  it("Timestamp-like (toMillis) → chaîne ISO 8601", () => {
    const { payload, mutated } = sanitizeMirrorPayload({
      when: { toMillis: () => 1_700_000_000_000 },
    });
    expect(mutated).toBe(true);
    expect(payload.when).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

describe("resilientQuery (requêtes résilientes)", () => {
  it("chemin Firestore : wheres + cap de scan + tri mémoire ascendant", async () => {
    firestoreState.queryResults = [
      { id: "b", nextAttemptAt: "2026-01-02T00:00:00.000Z" },
      { id: "a", nextAttemptAt: "2026-01-01T00:00:00.000Z" },
    ];
    const result = await resilientQuery<{ id: string }>(
      "videoRenderJobs",
      [{ field: "status", value: "queued" }],
      { orderField: "nextAttemptAt", limit: 10 },
    );
    expect(result.map((row) => row.id)).toEqual(["a", "b"]);
    expect(firestoreState.ops.some((op) => op.kind === "whereLimit" && op.path.includes("status"))).toBe(true);
  });

  it("erreur quota → chemin repli : filtres payload->> + order + limit", async () => {
    firestoreState.failWith = quotaError();
    supabaseState.rows = [
      { collection: "videoRenderJobs", document_id: "b", payload: { id: "b", status: "queued", nextAttemptAt: "2026-01-02T00:00:00.000Z" } },
      { collection: "videoRenderJobs", document_id: "a", payload: { id: "a", status: "queued", nextAttemptAt: "2026-01-01T00:00:00.000Z" } },
      { collection: "videoRenderJobs", document_id: "c", payload: { id: "c", status: "processing", nextAttemptAt: "2026-01-03T00:00:00.000Z" } },
    ];
    const result = await resilientQuery<{ id: string }>(
      "videoRenderJobs",
      [{ field: "status", value: "queued" }],
      { orderField: "nextAttemptAt" },
    );
    expect(result.map((row) => row.id)).toEqual(["a", "b"]);
    expect(supabaseState.ops.some((op) => op.op === "filter")).toBe(true);
    expect(supabaseState.ops.some((op) => op.op === "order")).toBe(true);
  });

  it("disjoncteur ouvert → repli direct sans Firestore", async () => {
    openBreaker();
    supabaseState.rows = [
      { collection: "videoProductionJobs", document_id: "p", payload: { id: "p", status: "queued" } },
    ];
    const result = await resilientQuery<{ id: string }>("videoProductionJobs", [{ field: "status", value: "queued" }]);
    expect(result).toHaveLength(1);
    expect(firestoreState.ops.some((op) => op.kind === "where")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 101 (C3a/C3b/C3c) — tri serveur + limit exact + repli index manquant
// ---------------------------------------------------------------------------

describe("resilientQuery — tri serveur + limit exact (Task 101)", () => {
  it("orderBy + limit DEMANDÉ appliqués côté Firestore : les N plus récents, plus jamais le cap 200", async () => {
    firestoreState.queryResults = Array.from({ length: 250 }, (_, index) => ({
      id: `doc-${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    }));
    const result = await resilientQuery<{ id: string }>(
      "videoRenderJobs",
      [{ field: "status", value: "queued" }],
      { orderField: "createdAt", descending: true, limit: 20 },
    );
    expect(result).toHaveLength(20);
    // Les 20 PLUS RÉCENTS (tri serveur simulé) — plus jamais un sous-ensemble
    // arbitraire de 200 documents re-trié après coup.
    expect(result[0]!.id).toBe("doc-250");
    expect(result[19]!.id).toBe("doc-231");
    // La requête Firestore a porté le tri ET la limite demandée (PAS 200).
    const query = firestoreState.ops.find((op) => op.kind === "whereLimit" && op.path.includes("status"));
    expect(query?.opts).toEqual({ order: { field: "createdAt", dir: "desc" }, limit: 20 });
  });

  it("FAILED_PRECONDITION (index composite manquant) → repli scan + tri mémoire, disjoncteur intact", async () => {
    firestoreState.failOrderedWith = missingIndexError();
    firestoreState.queryResults = [
      { id: "c", createdAt: "2026-01-03T00:00:00.000Z" },
      { id: "a", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", createdAt: "2026-01-02T00:00:00.000Z" },
    ];
    const result = await resilientQuery<{ id: string }>(
      "videoRenderJobs",
      [{ field: "status", value: "queued" }],
      { orderField: "createdAt", descending: true, limit: 2 },
    );
    // Résultats justes sur le sous-ensemble scanné (tri mémoire), fenêtre respectée.
    expect(result.map((row) => row.id)).toEqual(["c", "b"]);
    // Deux requêtes : la triée (échouée) puis le scan SANS orderBy — à
    // l'HORIZON de justesse de la couche (cap 200), pas à la seule limite.
    const queries = firestoreState.ops.filter((op) => op.kind === "whereLimit");
    expect(queries).toHaveLength(2);
    expect(queries[0]!.opts).toMatchObject({ order: { field: "createdAt", dir: "desc" } });
    expect(queries[1]!.opts).toEqual({ order: null, limit: 200 });
    // Ce n'est NI un quota NI un incident transitoire : le disjoncteur reste fermé.
    expect(getQuotaGuardStats().state).toBe("closed");
  });

  it("index manquant PUIS quota sur le scan → repli miroir Supabase (chaîne complète)", async () => {
    firestoreState.failOrderedWith = missingIndexError();
    firestoreState.failWith = quotaError();
    supabaseState.rows = [
      { collection: "videoRenderJobs", document_id: "m1", payload: { id: "m1", status: "queued", createdAt: "2026-01-02T00:00:00.000Z" } },
      { collection: "videoRenderJobs", document_id: "m2", payload: { id: "m2", status: "queued", createdAt: "2026-01-01T00:00:00.000Z" } },
    ];
    const result = await resilientQuery<{ id: string }>("videoRenderJobs", [{ field: "status", value: "queued" }], {
      orderField: "createdAt",
      descending: true,
      limit: 10,
    });
    expect(result.map((row) => row.id)).toEqual(["m1", "m2"]);
    // Le quota du scan a bien été noté au disjoncteur (chemin nominal épuisé).
    expect(getQuotaGuardStats().consecutiveQuotaErrors).toBe(1);
  });

  it("sans champ d'ordre : cap de scan historique conservé (200)", async () => {
    firestoreState.queryResults = [{ id: "x" }];
    await resilientQuery<{ id: string }>("videoRenderJobs", [{ field: "status", value: "queued" }]);
    const query = firestoreState.ops.find((op) => op.kind === "whereLimit");
    expect(query?.opts).toEqual({ order: null, limit: 200 });
  });
});

describe("resilientList / resilientListByPayloadField — limit (Task 101 / C3b)", () => {
  it("resilientList : limit paramétrable appliqué côté Firestore (défaut 200)", async () => {
    firestoreState.queryResults = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const limited = await resilientList<{ id: string }>("videoProjects", "userId", "u1", 2);
    expect(limited.map((row) => row.id)).toEqual(["a", "b"]);
    expect(firestoreState.ops.find((op) => op.kind === "whereLimit")?.opts).toEqual({ order: null, limit: 2 });

    firestoreState.ops.length = 0;
    await resilientList("videoProjects", "userId", "u1");
    expect(firestoreState.ops.find((op) => op.kind === "whereLimit")?.opts).toEqual({ order: null, limit: 200 });
  });

  it("resilientList : erreur quota → repli miroir lui aussi plafonné", async () => {
    firestoreState.failWith = quotaError();
    supabaseState.rows = [
      { collection: "videoProjects", document_id: "a", owner_id: "u1", payload: { id: "a" } },
      { collection: "videoProjects", document_id: "b", owner_id: "u1", payload: { id: "b" } },
    ];
    const list = await resilientList<{ id: string }>("videoProjects", "userId", "u1", 1);
    expect(list).toEqual([{ id: "a" }]);
    const selectRun = supabaseState.ops.find((op) => op.op === "select-run");
    expect((selectRun!.args as { limit: number }).limit).toBe(1);
  });

  it("resilientListByPayloadField : limit appliqué côté Firestore et côté miroir", async () => {
    firestoreState.queryResults = [{ id: "v1" }, { id: "v2" }, { id: "v3" }];
    const limited = await resilientListByPayloadField<{ id: string }>("videoVersions", "projectId", "p1", 2);
    expect(limited.map((row) => row.id)).toEqual(["v1", "v2"]);
    expect(firestoreState.ops.find((op) => op.kind === "whereLimit")?.opts).toEqual({ order: null, limit: 2 });

    firestoreState.failWith = quotaError();
    firestoreState.ops.length = 0;
    supabaseState.rows = [
      { collection: "videoVersions", document_id: "w1", owner_id: "u1", payload: { id: "w1", projectId: "p1" } },
      { collection: "videoVersions", document_id: "w2", owner_id: "u1", payload: { id: "w2", projectId: "p1" } },
      { collection: "videoVersions", document_id: "w3", owner_id: "u1", payload: { id: "w3", projectId: "p1" } },
    ];
    const mirrored = await resilientListByPayloadField<{ id: string }>("videoVersions", "projectId", "p1", 1);
    expect(mirrored).toEqual([{ id: "w1", projectId: "p1" }]);
    const selectRun = supabaseState.ops.find((op) => op.op === "select-run");
    expect((selectRun!.args as { limit: number }).limit).toBe(1);
  });
});

describe("isFirestoreMissingIndexError (Task 101)", () => {
  it("reconnaît le code gRPC 9 / FAILED_PRECONDITION et le message canonique", () => {
    expect(isFirestoreMissingIndexError(missingIndexError())).toBe(true);
    expect(isFirestoreMissingIndexError(new Error("9 FAILED_PRECONDITION: The query requires an index."))).toBe(true);
    expect(isFirestoreMissingIndexError(Object.assign(new Error("La requête nécessite un index."), { code: "failed-precondition" }))).toBe(true);
  });

  it("ne classe PAS quota / transitoire / métier comme index manquant", () => {
    expect(isFirestoreMissingIndexError(quotaError())).toBe(false);
    expect(isFirestoreMissingIndexError(transientError())).toBe(false);
    expect(isFirestoreMissingIndexError(Object.assign(new Error("permission denied"), { code: 7 }))).toBe(false);
  });
});

describe("reconcileFallbackToFirestore (ré-imbrication)", () => {
  it("Supabase absent → skipped", async () => {
    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    vi.mocked(getSupabaseAdmin).mockReturnValueOnce(null);
    const result = await reconcileFallbackToFirestore();
    expect(result).toEqual({ reconciled: 0, failed: 0, skipped: true });
  });

  it("disjoncteur ouvert → skipped (pas de sonde gaspillée)", async () => {
    openBreaker();
    const result = await reconcileFallbackToFirestore();
    expect(result.skipped).toBe(true);
  });

  it("ré-imbrique les lignes miroir dans Firestore (merge) et compte", async () => {
    supabaseState.rows = [
      { collection: "videoRenderJobs", document_id: "j5", payload: { id: "j5", status: "processing", progress: 90 }, updated_at: "2026-01-02T00:00:00.000Z" },
      { collection: "videoProductionJobs", document_id: "p5", payload: { id: "p5", stage: "voice" }, updated_at: "2026-01-01T00:00:00.000Z" },
    ];
    const result = await reconcileFallbackToFirestore();
    expect(result).toEqual({ reconciled: 2, failed: 0, skipped: false });
    expect(firestoreState.docs.get("videoRenderJobs/j5")?.data?.progress).toBe(90);
    expect(firestoreState.docs.get("videoProductionJobs/p5")?.data?.stage).toBe("voice");
    const setOps = firestoreState.ops.filter((op) => op.kind === "set");
    expect(setOps.every((op) => (op.opts as { merge?: boolean }).merge === true)).toBe(true);
  });

  it("s'arrête proprement quand le quota retombe pendant la boucle", async () => {
    supabaseState.rows = [
      { collection: "videoRenderJobs", document_id: "j6", payload: { id: "j6" }, updated_at: "2026-01-02T00:00:00.000Z" },
      { collection: "videoRenderJobs", document_id: "j7", payload: { id: "j7" }, updated_at: "2026-01-01T00:00:00.000Z" },
    ];
    // j6 s'écrit (path contient j6) mais j7 lève quota : le set échoue si le
    // doc cible contient "j7" — on simule via failWith activé après j6.
    firestoreState.failWith = null;
    const originalSet = firestoreState.docs.set.bind(firestoreState.docs);
    firestoreState.docs.set = ((key: string, value: { exists: boolean; data?: Record<string, unknown> }) => {
      if (key.includes("j7")) throw quotaError();
      return originalSet(key, value);
    }) as typeof firestoreState.docs.set;
    const result = await reconcileFallbackToFirestore();
    expect(result.reconciled).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(false);
  });

  it("collections par défaut = files vidéo + projets", () => {
    expect(DEFAULT_RECONCILE_COLLECTIONS).toContain("videoRenderJobs");
    expect(DEFAULT_RECONCILE_COLLECTIONS).toContain("videoProductionJobs");
    expect(DEFAULT_RECONCILE_COLLECTIONS).toContain("videoProjects");
  });
});

describe("resilientDelete (Task 96-c)", () => {
  it("nominal : delete Firestore + PURGE de la ligne miroir (anti-résurrection)", async () => {
    firestoreState.docs.set("chatConversations/c1", { exists: true, data: { userId: "u1", title: "Fil" } });
    supabaseState.rows = [
      { collection: "chatConversations", document_id: "c1", owner_id: "u1", payload: { userId: "u1", title: "Fil" } },
    ];
    await resilientDelete("chatConversations", "c1");
    expect(firestoreState.docs.has("chatConversations/c1")).toBe(false);
    expect(firestoreState.ops.some((op) => op.kind === "delete" && op.path === "chatConversations/c1")).toBe(true);
    // La ligne miroir a disparu : resilientGet ne peut plus la ressusciter.
    expect(supabaseState.rows).toHaveLength(0);
    expect(await resilientGet("chatConversations", "c1")).toBeNull();
  });

  it("nominal : doc absent de Firestore (idempotent) → miroir purgé quand même", async () => {
    supabaseState.rows = [
      { collection: "chatConversations", document_id: "c2", owner_id: "u1", payload: { userId: "u1" } },
    ];
    await resilientDelete("chatConversations", "c2");
    expect(supabaseState.rows).toHaveLength(0);
  });

  it("quota : purge du MIROIR seul, Firestore intact (doc conservé)", async () => {
    firestoreState.docs.set("chatConversations/c3", { exists: true, data: { userId: "u1" } });
    firestoreState.failWith = quotaError();
    supabaseState.rows = [
      { collection: "chatConversations", document_id: "c3", owner_id: "u1", payload: { userId: "u1" } },
    ];
    await resilientDelete("chatConversations", "c3");
    // Firestore factice : le throw précède la mutation → doc toujours présent.
    expect(firestoreState.docs.has("chatConversations/c3")).toBe(true);
    expect(supabaseState.rows).toHaveLength(0);
  });

  it("quota + Supabase absent → l'erreur de quota d'origine est propagée", async () => {
    firestoreState.failWith = quotaError();
    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    vi.mocked(getSupabaseAdmin).mockReturnValueOnce(null);
    await expect(resilientDelete("chatConversations", "c4")).rejects.toThrow("Quota exceeded");
  });

  it("erreur transitoire → rejetée SANS purge miroir ni disjoncteur", async () => {
    firestoreState.failWith = transientError();
    supabaseState.rows = [
      { collection: "chatConversations", document_id: "c5", owner_id: "u1", payload: { userId: "u1" } },
    ];
    await expect(resilientDelete("chatConversations", "c5")).rejects.toThrow("currently unavailable");
    expect(supabaseState.rows).toHaveLength(1);
  });

  it("erreur métier (code 7) → rejetée telle quelle, miroir intact", async () => {
    firestoreState.failWith = Object.assign(new Error("permission denied"), { code: 7 });
    supabaseState.rows = [
      { collection: "chatConversations", document_id: "c6", owner_id: "u1", payload: { userId: "u1" } },
    ];
    await expect(resilientDelete("chatConversations", "c6")).rejects.toThrow("permission denied");
    expect(supabaseState.rows).toHaveLength(1);
  });

  it("disjoncteur ouvert → purge miroir directe sans toucher Firestore", async () => {
    openBreaker();
    supabaseState.rows = [
      { collection: "chatConversations", document_id: "c7", owner_id: "u1", payload: { userId: "u1" } },
    ];
    await resilientDelete("chatConversations", "c7");
    expect(firestoreState.ops.some((op) => op.kind === "delete")).toBe(false);
    expect(supabaseState.rows).toHaveLength(0);
  });

  it("disjoncteur ouvert + Supabase absent → fallbackError", async () => {
    openBreaker();
    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    vi.mocked(getSupabaseAdmin).mockReturnValueOnce(null);
    await expect(resilientDelete("chatConversations", "c8")).rejects.toThrow(
      "Firestore quota atteinte et Supabase fallback indisponible.",
    );
  });
});

describe("resilientQuery includeIds + tri horodatage (Task 96-c)", () => {
  it("includeIds : injecte doc.id Firestore dans chaque résultat", async () => {
    firestoreState.queryResults = [{ title: "a" }, { title: "b" }];
    const result = await resilientQuery<{ id?: string; title: string }>(
      "chatConversations",
      [{ field: "userId", value: "u1" }],
      { includeIds: true },
    );
    // Le mock génère des ids q0, q1, … dans l'ordre des résultats.
    expect(result.map((row) => row.id)).toEqual(["q0", "q1"]);
    expect(result.map((row) => row.title)).toEqual(["a", "b"]);
  });

  it("includeIds côté repli : id = document_id miroir", async () => {
    firestoreState.failWith = quotaError();
    supabaseState.rows = [
      { collection: "agents", document_id: "agent-9", owner_id: "u1", payload: { ownerId: "u1", name: "Nine" } },
    ];
    const result = await resilientQuery<{ id?: string; name: string }>(
      "agents",
      [{ field: "ownerId", value: "u1" }],
      { includeIds: true },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("agent-9");
    expect(result[0]!.name).toBe("Nine");
  });

  it("tri mémoire sur Timestamp-like (toMillis) : ordre chronologique respecté", async () => {
    const old = { toMillis: () => 1_000 };
    const mid = { toMillis: () => 2_000 };
    const late = { toMillis: () => 3_000 };
    firestoreState.queryResults = [{ createdAt: late }, { createdAt: old }, { createdAt: mid }];
    const asc = await resilientQuery<{ createdAt: unknown }>("chatMessages", [{ field: "conversationId", value: "c" }], {
      orderField: "createdAt",
      includeIds: true,
    });
    expect(asc.map((row) => (row.createdAt as { toMillis: () => number }).toMillis())).toEqual([1_000, 2_000, 3_000]);
    const desc = await resilientQuery<{ createdAt: unknown }>("chatMessages", [{ field: "conversationId", value: "c" }], {
      orderField: "createdAt",
      descending: true,
    });
    expect(desc.map((row) => (row.createdAt as { toMillis: () => number }).toMillis())).toEqual([3_000, 2_000, 1_000]);
  });

  it("tri mémoire sur objets Date : ordre chronologique (mocks sans SDK)", async () => {
    firestoreState.queryResults = [
      { createdAt: new Date("2026-01-03T10:00:00Z") },
      { createdAt: new Date("2026-01-01T10:00:00Z") },
      { createdAt: new Date("2026-01-02T10:00:00Z") },
    ];
    const result = await resilientQuery<{ createdAt: Date }>("chatMessages", [{ field: "conversationId", value: "c" }], { orderField: "createdAt" });
    expect(result.map((row) => row.createdAt.toISOString())).toEqual([
      "2026-01-01T10:00:00.000Z",
      "2026-01-02T10:00:00.000Z",
      "2026-01-03T10:00:00.000Z",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Deadline anti-stall (Task 97) — comportement réel constaté en production :
// sous quota quotidien épuisé, les écritures Firestore pendent SANS erreur.
// ---------------------------------------------------------------------------

describe("deadline anti-stall (Task 97)", () => {
  it("resilientCreate : écriture Firestore qui ne répond JAMAIS → bascule miroir sous délai + disjoncteur ouvert", async () => {
    vi.useFakeTimers();
    try {
      firestoreState.hang = true;
      const pending = resilientCreate("chatConversations", "stall-1", { userId: "u1", title: "t" }, "u1");
      const awaited = vi.advanceTimersByTimeAsync(FIRESTORE_ATTEMPT_TIMEOUT_MS + 1).then(() => pending);
      await awaited;
      // Le miroir a reçu la ligne (insert de secours, disponibilité préservée).
      const mirrorRow = supabaseState.ops.find(
        (op) => op.op === "insert" && (op.args as Record<string, unknown>)?.collection === "chatConversations"
          && (op.args as Record<string, unknown>)?.document_id === "stall-1",
      );
      expect(mirrorRow).toBeDefined();
      // Le stall a ouvert le disjoncteur IMMÉDIATEMENT (signal coûteux = preuve suffisante).
      const stats = getQuotaGuardStats();
      expect(stats.state).toBe("open");
      expect(stats.stalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resilientGet : lecture qui ne répond jamais → miss miroir → null, circuit ouvert pour la suite", async () => {
    vi.useFakeTimers();
    try {
      firestoreState.hang = true;
      const pending = resilientGet("chatConversations", "stall-2");
      await vi.advanceTimersByTimeAsync(FIRESTORE_ATTEMPT_TIMEOUT_MS + 1).then(() => pending);
      expect(getQuotaGuardStats().state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("après UN stall, les appels suivants court-circuitent Firestore (miroir instantané, zéro nouvel appel Firestore)", async () => {
    vi.useFakeTimers();
    try {
      firestoreState.hang = true;
      const pending = resilientGet("chatConversations", "stall-3");
      await vi.advanceTimersByTimeAsync(FIRESTORE_ATTEMPT_TIMEOUT_MS + 1).then(() => pending);
      const firestoreOpsBefore = firestoreState.ops.length;

      // Circuit ouvert : ce set ne doit PAS tenter Firestore (aucun nouveau hang).
      await resilientSet("chatConversations", "stall-3", { title: "via miroir" }, { merge: true, ownerId: "u1" });
      expect(firestoreState.ops.length).toBe(firestoreOpsBefore);
      const mirrorRow = supabaseState.ops.find(
        (op) => op.op === "upsert" && (op.args as Record<string, unknown>)?.collection === "chatConversations"
          && (op.args as Record<string, unknown>)?.document_id === "stall-3",
      );
      expect(mirrorRow).toBeDefined();
      expect(getQuotaGuardStats().shortCircuits).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

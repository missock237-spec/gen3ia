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
  /** Résultats factices des requêtes where().get() / where().limit().get(). */
  queryResults: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (id: string) => {
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
          get: async () => {
            firestoreState.ops.push({ kind: "get", path });
            throwIfFailing();
            const doc = firestoreState.docs.get(path);
            if (!doc?.exists) return { exists: false, data: () => undefined };
            return { exists: true, data: () => doc.data };
          },
        };
      },
      where: (field: string, _op: string, value: unknown) => {
        const describe = `${name}?${field}==${String(value)}`;
        const runQuery = (limit?: number) => {
          firestoreState.ops.push({ kind: limit ? "whereLimit" : "where", path: describe });
          if (firestoreState.failWith) throw firestoreState.failWith;
          const results = limit ? firestoreState.queryResults.slice(0, limit) : firestoreState.queryResults;
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
  firestoreState.queryResults = [];
  supabaseState.rows = [];
  supabaseState.ops.length = 0;
  supabaseState.upsertError = null;
  supabaseState.insertError = null;
  supabaseState.selectError = null;
  resetQuotaGuardForTests();
}

import { noteFirestoreQuotaError, resetQuotaGuardForTests } from "./quota-guard";
import {
  DEFAULT_RECONCILE_COLLECTIONS,
  reconcileFallbackToFirestore,
  resilientCreate,
  resilientGet,
  resilientList,
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

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 101 (M3) — listRecentRuns : la vue « Missions récentes » lisait 80
 * documents arbitraires pour en afficher 8 (filtre userId seul + tri mémoire,
 * « sans index composite »). Le chemin nominal s'appuie désormais sur l'index
 * composite (userId, createdAt DESC) : orderBy SERVEUR + limit EXACT — 8
 * lectures au lieu de 80, et les 8 plus récents GARANTIS. Si l'index n'est
 * pas encore déployé, le repli historique (scan 80 + tri mémoire) absorbe
 * l'erreur FAILED_PRECONDITION : la disponibilité ne dépend jamais du
 * déploiement d'index, seule la facture lectures change.
 */

// ---------------------------------------------------------------------------
// État hoisted — Firestore factice
// ---------------------------------------------------------------------------

const firestoreState = vi.hoisted(() => ({
  queryResults: [] as Array<Record<string, unknown>>,
  ops: [] as Array<{ kind: string; path: string; opts?: unknown }>,
  /** Quand défini, chaque requête TRIÉE (orderBy posé) lève cette erreur. */
  failOrderedWith: null as unknown,
  /** Quand défini, chaque requête (triée ou non) lève cette erreur. */
  failWith: null as unknown,
}));

/** Comparateur de tri SERVEUR simulé (Date / toMillis / ISO / nombre / chaîne). */
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
  FieldValue: {
    serverTimestamp: () => ({ __serverTimestamp: true }),
    increment: (n: number) => ({ __increment: n }),
  },
  adminDb: {
    collection: (name: string) => {
      const state: { order: { field: string; dir: "asc" | "desc" } | null; limit: number | undefined } = {
        order: null,
        limit: undefined,
      };
      const builder = {
        where: () => builder,
        orderBy: (field: string, dir: "asc" | "desc" = "asc") => {
          state.order = { field, dir };
          return builder;
        },
        limit: (n: number) => {
          state.limit = n;
          return builder;
        },
        get: async () => {
          firestoreState.ops.push({
            kind: "query",
            path: name,
            opts: { order: state.order ? { ...state.order } : null, limit: state.limit ?? null },
          });
          if (state.order && firestoreState.failOrderedWith) throw firestoreState.failOrderedWith;
          if (firestoreState.failWith) throw firestoreState.failWith;
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
            docs: results.map((data, index) => ({ id: `r${index}`, data: () => data })),
            size: results.length,
          };
        },
      };
      return builder;
    },
    doc: () => ({
      id: "unused-doc-id",
      get: async () => ({ exists: false, data: () => undefined }),
      set: async () => ({}),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { listRecentRuns } from "./repository";

/** run minimal : docFrom n'exige que userId/conversationId/status + dates. */
function run(index: number, createdAt: Date): Record<string, unknown> {
  return {
    userId: "user-1",
    conversationId: "conv-1",
    objective: `Mission ${index + 1}`,
    status: "completed",
    steps: [],
    createdAt,
    updatedAt: createdAt,
  };
}

function missingIndexError(): Error {
  return Object.assign(
    new Error("The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/test/firestore/indexes"),
    { code: 9 },
  );
}

function quotaError(): Error {
  return Object.assign(new Error("Resource has been exhausted (e.g., check quota)."), { code: 8 });
}

beforeEach(() => {
  firestoreState.queryResults = [];
  firestoreState.ops.length = 0;
  firestoreState.failOrderedWith = null;
  firestoreState.failWith = null;
});

// ---------------------------------------------------------------------------
// listRecentRuns (Task 101 / M3)
// ---------------------------------------------------------------------------

describe("listRecentRuns — tri serveur + limit exact (Task 101 / M3)", () => {
  it("chemin indexé : orderBy(createdAt desc) + limit demandé côté serveur (8 lectures au lieu de 80)", async () => {
    // 30 runs semés dans le désordre : le serveur (index composite simulé)
    // renvoie directement les N plus récents.
    firestoreState.queryResults = Array.from({ length: 30 }, (_, index) =>
      run(index, new Date(Date.UTC(2026, 0, 1, 0, 0, index))),
    );
    const runs = await listRecentRuns("user-1");
    expect(runs).toHaveLength(8);
    // Les 8 PLUS RÉCENTS, du plus récent au plus ancien (ordre serveur).
    expect(runs[0]!.objective).toBe("Mission 30");
    expect(runs[7]!.objective).toBe("Mission 23");
    // Une SEULE requête, avec orderBy posé et la limite demandée (PAS 80).
    expect(firestoreState.ops).toHaveLength(1);
    expect(firestoreState.ops[0]!.opts).toEqual({ order: { field: "createdAt", dir: "desc" }, limit: 8 });
  });

  it("FAILED_PRECONDITION (index non déployé) → repli historique scan 80 + tri mémoire, mêmes gagnants", async () => {
    firestoreState.failOrderedWith = missingIndexError();
    firestoreState.queryResults = Array.from({ length: 30 }, (_, index) =>
      run(index, new Date(Date.UTC(2026, 0, 1, 0, 0, index))),
    );
    const runs = await listRecentRuns("user-1");
    expect(runs).toHaveLength(8);
    expect(runs[0]!.objective).toBe("Mission 30");
    // Deux requêtes : la triée (échouée) puis le scan SANS orderBy, cap 80.
    expect(firestoreState.ops).toHaveLength(2);
    expect(firestoreState.ops[0]!.opts).toMatchObject({ order: { field: "createdAt", dir: "desc" }, limit: 8 });
    expect(firestoreState.ops[1]!.opts).toEqual({ order: null, limit: 80 });
  });

  it("erreur QUOTA sur le chemin trié → PROPAGÉE (pas de repli au-delà de l'index manquant)", async () => {
    firestoreState.failOrderedWith = quotaError();
    await expect(listRecentRuns("user-1")).rejects.toThrow("Resource has been exhausted");
    expect(firestoreState.ops).toHaveLength(1);
  });

  it("limit demandé borné à 20 (contrat de fenêtre préservé)", async () => {
    firestoreState.queryResults = [run(0, new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))];
    await listRecentRuns("user-1", 50);
    expect(firestoreState.ops[0]!.opts).toEqual({ order: { field: "createdAt", dir: "desc" }, limit: 20 });
  });

  it("aucun run : liste vide, sans erreur", async () => {
    const runs = await listRecentRuns("user-1");
    expect(runs).toEqual([]);
  });
});

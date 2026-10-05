import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 101 (m5) — listArtifacts : l'ancienne requête appliquait `.limit(limit)`
 * AVANT le tri mémoire — le sous-ensemble renvoyé par Firestore était
 * ARBITRAIRE (audit : « 100 arbitraires ») et le tri mémoire n'était que
 * cosmétique. Choix Task 101 (documenté dans le dépôt) : les familles de
 * filtres étant combinatoires (conversationId, projectId, runId, type), pas
 * de orderBy serveur (chaque combinaison exigerait son index composite) —
 * le compromis retenu est celui du chat : cap de scan 200 (Firestore ne
 * facture que les documents RENVOYÉS), tri mémoire updatedAt desc PUIS
 * découpage à la limite demandée.
 */

// ---------------------------------------------------------------------------
// État hoisted — Firestore factice
// ---------------------------------------------------------------------------

const firestoreState = vi.hoisted(() => ({
  queryResults: [] as Array<Record<string, unknown>>,
  ops: [] as Array<{ kind: string; path: string; filters: string[]; opts?: unknown }>,
}));

vi.mock("@/lib/firebase/admin", () => ({
  FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
  adminDb: {
    collection: (name: string) => {
      const state = {
        filters: [] as string[],
        limit: undefined as number | undefined,
      };
      const builder = {
        where: (field: string, op: string, value: unknown) => {
          state.filters.push(`${field}${op}${String(value)}`);
          return builder;
        },
        // orderBy ne doit JAMAIS être posé sur cette requête (choix m5 :
        // cap de scan + tri mémoire, pas d'index composite par combinaison).
        orderBy: () => {
          throw new Error("listArtifacts ne doit PAS poser orderBy côté Firestore (contrat Task 101 / m5).");
        },
        limit: (n: number) => {
          state.limit = n;
          return builder;
        },
        get: async () => {
          firestoreState.ops.push({ kind: "query", path: name, filters: [...state.filters], opts: { limit: state.limit ?? null } });
          let results = [...firestoreState.queryResults];
          if (state.limit !== undefined) results = results.slice(0, state.limit);
          return {
            docs: results.map((data, index) => ({ id: `a${index}`, data: () => data })),
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
      delete: async () => ({}),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { listArtifacts } from "./repository";

function artifact(index: number, updatedAt: Date): Record<string, unknown> {
  return {
    userId: "user-1",
    type: "code",
    title: `Artefact ${index + 1}`,
    content: `contenu ${index + 1}`,
    versions: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

beforeEach(() => {
  firestoreState.queryResults = [];
  firestoreState.ops.length = 0;
});

// ---------------------------------------------------------------------------
// listArtifacts (Task 101 / m5)
// ---------------------------------------------------------------------------

describe("listArtifacts — cap de scan + tri mémoire correct (Task 101 / m5)", () => {
  it("cap de scan 200 posé côté Firestore même pour une limite de 50 (le tri vient APRÈS)", async () => {
    firestoreState.queryResults = Array.from({ length: 60 }, (_, index) =>
      artifact(index, new Date(Date.UTC(2026, 0, 1, 0, 0, index))),
    );
    const artifacts = await listArtifacts("user-1", { limit: 50 });
    // La LIMITE demandée borne le résultat, mais le SCAN Firestore est le cap.
    expect(artifacts).toHaveLength(50);
    expect(firestoreState.ops[0]!.opts).toEqual({ limit: 200 });
    // Filtrage d'ownership posé côté Firestore.
    expect(firestoreState.ops[0]!.filters).toContain("userId==user-1");
  });

  it("les N PLUS RÉCENTS sont renvoyés (tri updatedAt desc après le scan, plus d'arbitraire)", async () => {
    // 60 artefacts : les 50 plus récents doivent gagner, quel que soit
    // l'ordre de renvoi Firestore (ici volontairement mélangé).
    firestoreState.queryResults = Array.from({ length: 60 }, (_, index) =>
      artifact(index, new Date(Date.UTC(2026, 0, 1, 0, 0, 59 - index))),
    );
    const artifacts = await listArtifacts("user-1", { limit: 50 });
    expect(artifacts).toHaveLength(50);
    expect(artifacts[0]!.title).toBe("Artefact 1"); // updatedAt le plus récent
    expect(artifacts[49]!.title).toBe("Artefact 50"); // 50e plus récent
    // Ordre strictement décroissant.
    for (let i = 1; i < artifacts.length; i += 1) {
      expect(artifacts[i - 1]!.updatedAt >= artifacts[i]!.updatedAt).toBe(true);
    }
  });

  it("filtres combinés transmis à Firestore (type, conversationId)", async () => {
    firestoreState.queryResults = [artifact(0, new Date(Date.UTC(2026, 0, 1)))];
    await listArtifacts("user-1", { type: "code", conversationId: "conv-1", limit: 10 });
    expect(firestoreState.ops[0]!.filters).toEqual(["userId==user-1", "conversationId==conv-1", "type==code"]);
    expect(firestoreState.ops[0]!.opts).toEqual({ limit: 200 });
  });

  it("limite demandée plafonnée à 200, défaut 50", async () => {
    firestoreState.queryResults = [];
    await listArtifacts("user-1", { limit: 500 });
    expect(firestoreState.ops[0]!.opts).toEqual({ limit: 200 });

    firestoreState.ops.length = 0;
    await listArtifacts("user-1");
    expect(firestoreState.ops[0]!.opts).toEqual({ limit: 200 });
  });

  it("collection vide : liste vide, sans erreur", async () => {
    const artifacts = await listArtifacts("user-1");
    expect(artifacts).toEqual([]);
  });
});

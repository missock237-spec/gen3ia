import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHUNKED_COMMIT_SIZE, commitOpsInChunks, type ChunkedWriteOp } from "./chunked-commit";

/**
 * Helper d'écritures Firestore par lots (Task 3-b, lot B1) : la limite dure
 * de 500 opérations par batch rend obligatoire le découpage. Le mock est un
 * Firestore factice (DI : db passé en paramètre) qui enregistre les batchs.
 */

interface FakeBatch {
  ops: ChunkedWriteOp[];
  committed: boolean;
  commit: ReturnType<typeof vi.fn>;
}

function fakeDb() {
  const batches: FakeBatch[] = [];
  const db = {
    batch: () => {
      const batch: FakeBatch = { ops: [], committed: false, commit: vi.fn(async () => { batch.committed = true; }) };
      batches.push(batch);
      const track = (kind: string) => (ref: unknown, data?: unknown, options?: unknown) => {
        batch.ops.push({ kind, ref, data, options } as unknown as ChunkedWriteOp);
        return batch;
      };
      return {
        delete: (ref: unknown) => { batch.ops.push({ kind: "delete", ref } as ChunkedWriteOp); return batch; },
        create: track("create"),
        set: track("set"),
        update: track("update"),
        commit: batch.commit,
      };
    },
  };
  return { db, batches };
}

function deleteOp(id: string): ChunkedWriteOp {
  return { kind: "delete", ref: { path: `docs/${id}` } } as ChunkedWriteOp;
}

describe("commitOpsInChunks", () => {
  let state: ReturnType<typeof fakeDb>;
  beforeEach(() => { state = fakeDb(); });

  it("ne crée qu'un seul batch sous la taille de lot", async () => {
    const committed = await commitOpsInChunks(state.db, Array.from({ length: 10 }, (_, i) => deleteOp(String(i))));
    expect(committed).toBe(10);
    expect(state.batches).toHaveLength(1);
    expect(state.batches[0]!.ops).toHaveLength(10);
    expect(state.batches[0]!.commit).toHaveBeenCalledTimes(1);
  });

  it("découpe 1000 opérations en lots de 450 (450/450/100) par défaut", async () => {
    const committed = await commitOpsInChunks(state.db, Array.from({ length: 1000 }, (_, i) => deleteOp(String(i))));
    expect(committed).toBe(1000);
    expect(CHUNKED_COMMIT_SIZE).toBe(450);
    expect(state.batches.map((b) => b.ops.length)).toEqual([450, 450, 100]);
    // Chaque batch reste sous la limite dure de Firestore (500 ops).
    for (const batch of state.batches) expect(batch.ops.length).toBeLessThanOrEqual(500);
  });

  it("respecte une taille de lot personnalisée", async () => {
    const committed = await commitOpsInChunks(state.db, Array.from({ length: 7 }, (_, i) => deleteOp(String(i))), 3);
    expect(committed).toBe(7);
    expect(state.batches.map((b) => b.ops.length)).toEqual([3, 3, 1]);
  });

  it("refuse une taille de lot invalide (0, >500, non entière)", async () => {
    await expect(commitOpsInChunks(state.db, [], 0)).rejects.toThrow(/Taille de lot invalide/);
    await expect(commitOpsInChunks(state.db, [], 501)).rejects.toThrow(/Taille de lot invalide/);
    await expect(commitOpsInChunks(state.db, [], 2.5)).rejects.toThrow(/Taille de lot invalide/);
    expect(state.batches).toHaveLength(0);
  });

  it("ne commit rien pour une liste vide", async () => {
    const committed = await commitOpsInChunks(state.db, []);
    expect(committed).toBe(0);
    expect(state.batches).toHaveLength(0);
  });

  it("transmet chaque type d'opération au batch (delete/create/set/update)", async () => {
    const ref = { path: "docs/x" };
    const ops: ChunkedWriteOp[] = [
      { kind: "delete", ref },
      { kind: "create", ref, data: { a: 1 } },
      { kind: "set", ref, data: { b: 2 }, options: { merge: true } },
      { kind: "update", ref, data: { c: 3 } },
    ];
    const committed = await commitOpsInChunks(state.db, ops, 10);
    expect(committed).toBe(4);
    expect(state.batches[0]!.ops.map((op) => op.kind)).toEqual(["delete", "create", "set", "update"]);
  });

  it("propage l'échec du commit et arrête la boucle", async () => {
    state.db.batch = () => {
      const batch: FakeBatch = { ops: [], committed: false, commit: vi.fn(async () => { throw new Error("quota Firestore épuisé"); }) };
      return {
        delete: (ref: unknown) => { batch.ops.push({ kind: "delete", ref } as ChunkedWriteOp); return batch; },
        create: () => batch, set: () => batch, update: () => batch,
        commit: batch.commit,
      };
    };
    await expect(commitOpsInChunks(state.db, Array.from({ length: 900 }, (_, i) => deleteOp(String(i))))).rejects.toThrow(/quota/);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lot B2 (Task 3-b) — idempotence d'exécution avec bail : un claim
 * `processing` plus vieux que CLAIMS_PROCESSING_MS est un process mort
 * (kill entre claim et complete/fail) et doit être re-claimable, tandis
 * qu'un claim vivant bloque le doublon. Chaque doc porte `expireAt` pour
 * la policy TTL Firestore (pas de croissance infinie).
 *
 * Mock : adminDb factice via vi.mock("@/lib/firebase/admin") (pattern
 * dépôt) ; FieldValue réel (serverTimestamp fonctionne hors réseau).
 */

const idempotencyState = vi.hoisted(() => {
  const state = {
    doc: null as null | Record<string, unknown>,
    created: [] as Array<Record<string, unknown>>,
    overwritten: [] as Array<Record<string, unknown>>,
    updated: [] as Array<Record<string, unknown>>,
    docId: "" as string,
  };
  return state;
});

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (id: string) => {
        idempotencyState.docId = `${name}/${id}`;
        return {
          // runTransaction : tx.get(ref) lit l'état courant.
          get: async () => {
            if (!idempotencyState.doc) return { exists: false, data: () => undefined };
            return { exists: true, data: () => idempotencyState.doc };
          },
          // Chemins hors transaction (complete/fail).
          update: async (payload: Record<string, unknown>) => {
            idempotencyState.updated.push(payload);
            idempotencyState.doc = { ...(idempotencyState.doc ?? {}), ...payload };
          },
        };
      },
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
        create: (_ref: unknown, payload: Record<string, unknown>) => {
          idempotencyState.created.push(payload);
          // Persistance simulée : le doc existe dès la fin de transaction.
          idempotencyState.doc = payload;
        },
        set: (_ref: unknown, payload: Record<string, unknown>) => { idempotencyState.overwritten.push(payload); },
      }),
  },
}));

import {
  CLAIMS_PROCESSING_MS,
  CLAIMS_TTL_MS,
  claimExecutionIdempotency,
  completeExecutionIdempotency,
  failExecutionIdempotency,
} from "./execution-idempotency";

const PARAMS = { userId: "user-1", toolName: "composio.execute", key: "approval-1", input: { toolSlug: "gmail.send" } };

function timestampLike(ageMs: number) {
  return { toMillis: () => Date.now() - ageMs };
}

beforeEach(() => {
  idempotencyState.doc = null;
  idempotencyState.created = [];
  idempotencyState.overwritten = [];
  idempotencyState.updated = [];
  idempotencyState.docId = "";
});

describe("claimExecutionIdempotency (claim initial)", () => {
  it("crée un claim processing avec bail expireAt et claimCount 1", async () => {
    const claim = await claimExecutionIdempotency(PARAMS);
    expect(claim.state).toBe("processing");
    expect(idempotencyState.created).toHaveLength(1);
    const payload = idempotencyState.created[0]!;
    expect(payload.state).toBe("processing");
    expect(payload.claimCount).toBe(1);
    expect(payload.expireAt).toBeInstanceOf(Date);
    expect((payload.expireAt as Date).getTime()).toBeGreaterThanOrEqual(Date.now() + CLAIMS_TTL_MS - 5_000);
  });

  it("refuse des paramètres vides", async () => {
    await expect(claimExecutionIdempotency({ ...PARAMS, userId: " " })).rejects.toThrow(/Invalid idempotency/);
  });

  it("détecte un conflit d'arguments pour la même clé", async () => {
    await claimExecutionIdempotency(PARAMS);
    await expect(claimExecutionIdempotency({ ...PARAMS, input: { toolSlug: "other" } })).rejects.toThrow(/conflict/);
  });
});

describe("claimExecutionIdempotency (staleness du bail)", () => {
  it("bloque un doublon tant que le claim processing est vivant", async () => {
    const first = await claimExecutionIdempotency(PARAMS);
    idempotencyState.doc = { ...idempotencyState.created[0]!, updatedAt: timestampLike(0) };
    void first;
    await expect(claimExecutionIdempotency(PARAMS)).rejects.toThrow(/already processing/);
    expect(idempotencyState.overwritten).toHaveLength(0);
  });

  it("re-claim un claim processing plus vieux que CLAIMS_PROCESSING_MS (process mort)", async () => {
    await claimExecutionIdempotency(PARAMS);
    idempotencyState.doc = { ...idempotencyState.created[0]!, updatedAt: timestampLike(CLAIMS_PROCESSING_MS + 1_000) };
    const claim = await claimExecutionIdempotency(PARAMS);
    expect(claim.state).toBe("processing");
    expect(idempotencyState.overwritten).toHaveLength(1);
    const payload = idempotencyState.overwritten[0]!;
    expect(payload.state).toBe("processing");
    expect(payload.claimCount).toBe(2);
    expect(payload.expireAt).toBeInstanceOf(Date);
  });

  it("reste prudent quand l'horodatage est illisible (doc corrompu)", async () => {
    await claimExecutionIdempotency(PARAMS);
    idempotencyState.doc = { ...idempotencyState.created[0]!, updatedAt: "corrompu" };
    await expect(claimExecutionIdempotency(PARAMS)).rejects.toThrow(/already processing/);
  });
});

describe("claimExecutionIdempotency (états finaux)", () => {
  it("renvoie le résultat d'un claim completed", async () => {
    await claimExecutionIdempotency(PARAMS);
    idempotencyState.doc = { ...idempotencyState.created[0]!, state: "completed", result: { ok: true } };
    const claim = await claimExecutionIdempotency(PARAMS);
    expect(claim.state).toBe("completed");
    expect(claim.result).toEqual({ ok: true });
  });

  it("renvoie l'erreur d'un claim failed", async () => {
    await claimExecutionIdempotency(PARAMS);
    idempotencyState.doc = { ...idempotencyState.created[0]!, state: "failed", error: "API distante en panne" };
    const claim = await claimExecutionIdempotency(PARAMS);
    expect(claim.state).toBe("failed");
    expect(claim.error).toBe("API distante en panne");
  });
});

describe("finalisation (complete/fail)", () => {
  it("complete avec expireAt rafraîchi", async () => {
    const claim = await claimExecutionIdempotency(PARAMS);
    await completeExecutionIdempotency({ key: claim.key, result: { done: 1 } });
    expect(idempotencyState.updated).toHaveLength(1);
    const payload = idempotencyState.updated[0]!;
    expect(payload.state).toBe("completed");
    expect(payload.result).toEqual({ done: 1 });
    expect(payload.expireAt).toBeInstanceOf(Date);
  });

  it("refuse un résultat dépassant la limite de persistance", async () => {
    await expect(
      completeExecutionIdempotency({ key: "k", result: { blob: "x".repeat(200_001) } }),
    ).rejects.toThrow(/persistence limit/);
  });

  it("échoue avec une erreur tronquée à 4000 caractères", async () => {
    const claim = await claimExecutionIdempotency(PARAMS);
    await failExecutionIdempotency({ key: claim.key, error: "e".repeat(5_000) });
    const payload = idempotencyState.updated[0]!;
    expect(payload.state).toBe("failed");
    expect((payload.error as string).length).toBe(4_000);
  });
});

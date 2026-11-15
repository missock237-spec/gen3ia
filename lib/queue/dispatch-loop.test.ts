import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Contrôleur de la boucle de dispatch (Task 62) — EXACTEMENT UN SUCCESSEUR
 * par slot, sans dédup QStash (absente de la build du compte, vérifié en
 * sondes réelles) : le contrôle est transactionnel Firestore.
 *
 * Le mock Firestore est minimaliste : un document `dispatchLoop/control`
 * en mémoire, set-merge, runTransaction séquentiel (pas de concurrence
 * simulée — la sémantique de sérialisation est portée par Firestore lui-
 * même ; ce que ces tests verrouillent est l'ORDRE et les CONDITIONS).
 */

const docs = new Map<string, Record<string, unknown>>();
const txOperations: string[] = [];

function docData(path: string): Record<string, unknown> {
  return docs.get(path) ?? {};
}

vi.mock("@/lib/r2fs", () => ({
  FieldValue: {
    delete: () => "__DELETE__",
    increment: (n: number) => ({ __increment__: n }),
  },
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        async get(ref: { path: string }) {
          txOperations.push(`get:${ref.path}`);
          return {
            exists: docs.has(ref.path),
            data: () => docData(ref.path),
          };
        },
        set(ref: { path: string }, data: Record<string, unknown>, _opts?: unknown) {
          txOperations.push(`set:${ref.path}`);
          const current = docData(ref.path);
          const merged = { ...current };
          for (const [k, v] of Object.entries(data)) {
            if (v === "__DELETE__") delete merged[k];
            else merged[k] = v;
          }
          docs.set(ref.path, merged);
        },
        update(ref: { path: string }, data: Record<string, unknown>) {
          txOperations.push(`update:${ref.path}`);
          docs.set(ref.path, { ...docData(ref.path), ...data });
        },
      }),
    collection: (name: string) => ({
      doc: (id: string) => ({ path: `${name}/${id}` }),
    }),
  },
}));

import { DISPATCH_SLOT_MS, scheduleNextDispatchTick, slotFor } from "./dispatch-loop";

const CONTROL = "dispatchLoop/control";

function publishMock(result: { messageId: string } | null = { messageId: "msg_1" }) {
  return vi.fn(result ? async () => result : async () => null);
}

const ORIGIN = "https://gen3ia.online";

beforeEach(() => {
  docs.clear();
  txOperations.length = 0;
});

describe("slotFor / constantes", () => {
  it("découpe le temps en slots de 5 minutes", () => {
    expect(DISPATCH_SLOT_MS).toBe(300_000);
    expect(slotFor(0)).toBe(0);
    expect(slotFor(299_999)).toBe(0);
    expect(slotFor(300_000)).toBe(1);
    expect(slotFor(1_234_567_890)).toBe(Math.floor(1_234_567_890 / 300_000));
  });
});

describe("scheduleNextDispatchTick — publication exactement une fois", () => {
  it("publie le tick du slot suivant avec le délai calé sur la frontière", async () => {
    const publish = publishMock();
    const now = 1_234_567_890; // slot 4115, frontière suivante à (4116)*300000
    const fromSlot = slotFor(now);

    const outcome = await scheduleNextDispatchTick(ORIGIN, fromSlot, now, publish);

    expect(outcome).toMatchObject({ kind: "published", slotEpoch: fromSlot + 1 });
    const delay = (outcome as { delaySeconds: number }).delaySeconds;
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(302);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ slotEpoch: fromSlot + 1 });
    expect(docs.get(CONTROL)?.publishedSlotEpoch).toBe(fromSlot + 1);
  });

  it("un tick redelivré (même slot déjà publié) NE publie PAS un second successeur", async () => {
    const publish = publishMock();
    const fromSlot = 5_000;
    const now = fromSlot * DISPATCH_SLOT_MS + 10_000;

    const first = await scheduleNextDispatchTick(ORIGIN, fromSlot, now, publish);
    const second = await scheduleNextDispatchTick(ORIGIN, fromSlot, now + 1_000, publish);

    expect(first).toMatchObject({ kind: "published" });
    expect(second).toMatchObject({ kind: "already-scheduled", slotEpoch: fromSlot + 1 });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("un tick EN RETARD reprend depuis le slot courant (pas de retombée dans le passé)", async () => {
    const publish = publishMock();
    const staleSlot = 1_000;
    const now = 5_555 * DISPATCH_SLOT_MS + 60_000; // slot 5555

    const outcome = await scheduleNextDispatchTick(ORIGIN, staleSlot, now, publish);

    expect(outcome).toMatchObject({ kind: "published", slotEpoch: 5_556 });
  });

  it("échec du publish → réservation libérée + publish-failed (le 5xx du tick redéclenchera)", async () => {
    const publish = vi.fn(async () => {
      throw new Error("QStash publish 503: unavailable");
    });
    const fromSlot = 7_000;
    const now = fromSlot * DISPATCH_SLOT_MS + 5_000;

    const outcome = await scheduleNextDispatchTick(ORIGIN, fromSlot, now, publish);

    expect(outcome).toMatchObject({ kind: "publish-failed", slotEpoch: fromSlot + 1 });
    expect(docs.get(CONTROL)?.publishedSlotEpoch).toBeUndefined();
    expect(docs.get(CONTROL)?.publishingSlotEpoch).toBeUndefined();

    // Redélivrance du même tick : la réservation étant libérée, le publish repart.
    const retry = publishMock();
    const retried = await scheduleNextDispatchTick(ORIGIN, fromSlot, now + 2_000, retry);
    expect(retried).toMatchObject({ kind: "published" });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("réservation vivante d'un concurrent → publish-conflict, pas de double publish", async () => {
    const fromSlot = 9_000;
    const now = fromSlot * DISPATCH_SLOT_MS + 5_000;

    // Un concurrent a réservé le publish il y a 5 s (< 60 s de staleness).
    docs.set(CONTROL, { publishingSlotEpoch: fromSlot + 1, publishingAtMs: now - 5_000, publishedSlotEpoch: -1 });

    const publish = publishMock();
    const outcome = await scheduleNextDispatchTick(ORIGIN, fromSlot, now, publish);

    expect(outcome).toMatchObject({ kind: "publish-conflict" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("réservation STALE (> 60 s, tick killé) → reprise propre du publish", async () => {
    const fromSlot = 11_000;
    const now = fromSlot * DISPATCH_SLOT_MS + 5_000;

    docs.set(CONTROL, { publishingSlotEpoch: fromSlot + 1, publishingAtMs: now - 120_000, publishedSlotEpoch: -1 });

    const publish = publishMock();
    const outcome = await scheduleNextDispatchTick(ORIGIN, fromSlot, now, publish);

    expect(outcome).toMatchObject({ kind: "published", slotEpoch: fromSlot + 1 });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("file non configurée (publish → null) → publish-conflict + réservation libérée", async () => {
    const fromSlot = 13_000;
    const now = fromSlot * DISPATCH_SLOT_MS + 5_000;

    const outcome = await scheduleNextDispatchTick(ORIGIN, fromSlot, now, publishMock(null));

    expect(outcome).toMatchObject({ kind: "publish-conflict" });
    expect(docs.get(CONTROL)?.publishingSlotEpoch).toBeUndefined();
    expect(docs.get(CONTROL)?.publishedSlotEpoch).toBeUndefined();
  });
});

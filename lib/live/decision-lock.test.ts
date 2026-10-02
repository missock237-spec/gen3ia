import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Verrou de décision vision Live (Task 62) : distribué Redis quand il est
 * configuré, repli mémoire Task 45 sinon. Les deux chemins sont testés en
 * basculant le mock de getRedis.
 */

const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  exists: vi.fn(),
}));

vi.mock("@/lib/cache/redis", () => ({
  getRedis: () => (redisActive ? redisMock : null),
}));

let redisActive = false;

import {
  acquireDecisionLock,
  getPreviousFramePrint,
  isDecisionInFlight,
  releaseDecisionLock,
  resetDecisionLockForTests,
  setFramePrint,
} from "./decision-lock";

beforeEach(() => {
  vi.clearAllMocks();
  resetDecisionLockForTests();
  redisActive = false;
});

describe("repli mémoire (Redis absent — sémantique Task 45)", () => {
  it("acquire → en vol → release → plus en vol", async () => {
    const first = await acquireDecisionLock("sess-1");
    expect(first).toEqual({ acquired: true, distributed: false });

    expect(await isDecisionInFlight("sess-1")).toBe(true);
    const second = await acquireDecisionLock("sess-1");
    expect(second.acquired).toBe(false);

    await releaseDecisionLock("sess-1");
    expect(await isDecisionInFlight("sess-1")).toBe(false);
  });

  it("sessions distinctes : verrous indépendants", async () => {
    expect((await acquireDecisionLock("a")).acquired).toBe(true);
    expect((await acquireDecisionLock("b")).acquired).toBe(true);
  });

  it("empreinte de frame : set puis get", async () => {
    await setFramePrint("sess-2", { hash: "abc", feedbackAt: 123 });
    expect(await getPreviousFramePrint("sess-2")).toEqual({ hash: "abc", feedbackAt: 123 });
    expect(await getPreviousFramePrint("inconnu")).toBeNull();
  });
});

describe("chemin distribué Redis (configuré)", () => {
  it("acquisition atomique via SET NX PX ; conflit si la clé existe", async () => {
    redisActive = true;
    redisMock.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    const first = await acquireDecisionLock("sess-r");
    const second = await acquireDecisionLock("sess-r");

    expect(first).toEqual({ acquired: true, distributed: true });
    expect(second.acquired).toBe(false);
    expect(redisMock.set).toHaveBeenCalledWith(
      "live-lock:sess-r",
      expect.any(Number),
      { nx: true, px: 30_000 },
    );
  });

  it("isDecisionInFlight interroge Redis (read-only)", async () => {
    redisActive = true;
    redisMock.exists.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await isDecisionInFlight("sess-r2")).toBe(true);
    expect(await isDecisionInFlight("sess-r2")).toBe(false);
  });

  it("empreinte partagée via Redis avec TTL 10 min ; repli local uniquement en ERREUR Redis", async () => {
    redisActive = true;
    redisMock.set.mockResolvedValueOnce("OK").mockRejectedValueOnce(new Error("down"));
    // Redis répond : autorité. Clé absente = pas de dédup (TTL expiré), même si
    // le local en a une — le local n'est consulté que quand Redis est injoignable.
    redisMock.get.mockResolvedValueOnce({ hash: "h1", feedbackAt: 5 });

    await setFramePrint("sess-r3", { hash: "h1", feedbackAt: 5 });
    expect(await getPreviousFramePrint("sess-r3")).toEqual({ hash: "h1", feedbackAt: 5 });

    await setFramePrint("sess-r3", { hash: "h2", feedbackAt: 9 }); // Redis KO → local seulement
    redisMock.get.mockRejectedValueOnce(new Error("network down"));
    expect(await getPreviousFramePrint("sess-r3")).toEqual({ hash: "h2", feedbackAt: 9 });
  });

  it("release supprime la clé Redis (fin de décision)", async () => {
    redisActive = true;
    redisMock.set.mockResolvedValueOnce("OK");
    await acquireDecisionLock("sess-r4");
    await releaseDecisionLock("sess-r4");
    expect(redisMock.del).toHaveBeenCalledWith("live-lock:sess-r4");
  });
});

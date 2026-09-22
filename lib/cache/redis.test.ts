import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests du socle Redis :
 *  - sans configuration : repli local transparent (jamais d'exception) ;
 *  - avec client simulé : fenêtre fixe distribuée, pipeline, tolérance aux
 *    erreurs réseau.
 */

const mockedRedisInstance = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  ping: vi.fn(),
  incr: vi.fn(),
  pexpire: vi.fn(),
  pttl: vi.fn(),
  pipeline: vi.fn(),
};

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(function Redis() {
    return mockedRedisInstance;
  }),
}));

import {
  cacheDelete,
  cacheGet,
  cacheSet,
  cacheWrap,
  isRedisConfigured,
  rateLimitDistributed,
  redisPing,
  resetRedisClientForTests,
} from "./redis";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  resetRedisClientForTests();
  mockedRedisInstance.pipeline.mockReturnValue({
    incr: vi.fn().mockReturnThis(),
    pexpire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([1, 1]),
  });
});

function activerRedisSimule(): void {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis-simule.test.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token-de-test";
  resetRedisClientForTests();
}

describe("cache Redis — repli sans configuration", () => {
  it("isRedisConfigured retourne false quand les variables sont absentes", () => {
    // L'environnement de test ne définit pas UPSTASH_REDIS_REST_URL/TOKEN.
    expect(isRedisConfigured()).toBe(false);
  });

  it("cacheGet retourne null sans lever d'exception", async () => {
    await expect(cacheGet("k")).resolves.toBeNull();
  });

  it("cacheSet retourne false (pas de cache)", async () => {
    await expect(cacheSet("k", { a: 1 })).resolves.toBe(false);
  });

  it("cacheDelete retourne false", async () => {
    await expect(cacheDelete("k")).resolves.toBe(false);
  });

  it("redisPing retourne false", async () => {
    await expect(redisPing()).resolves.toBe(false);
  });

  it("cacheWrap exécute le loader à chaque appel (pas de cache)", async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { v: calls };
    };
    const first = await cacheWrap("k", 60, loader);
    const second = await cacheWrap("k", 60, loader);
    expect(first.hit).toBe(false);
    expect(second.hit).toBe(false);
    expect(calls).toBe(2);
  });
});

describe("rateLimitDistributed — fenêtre fixe via Redis", () => {
  it("laisse passer la première requête et expose remaining", async () => {
    activerRedisSimule();
    mockedRedisInstance.pipeline.mockReturnValue({
      incr: vi.fn().mockReturnThis(),
      pexpire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([1, 1]),
    });
    const result = await rateLimitDistributed("test:premiere", { limit: 5, windowMs: 60_000 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(result.distributed).toBe(true);
  });

  it("bloque au-delà de la limite avec retryAfterMs depuis le TTL", async () => {
    activerRedisSimule();
    mockedRedisInstance.pipeline.mockReturnValue({
      incr: vi.fn().mockReturnThis(),
      pexpire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([6, 1]),
    });
    mockedRedisInstance.pttl.mockResolvedValue(42_000);
    const result = await rateLimitDistributed("test:sature", { limit: 5, windowMs: 60_000 });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBe(42_000);
    expect(result.distributed).toBe(true);
  });

  it("repli local si Redis lève une erreur (jamais de blocage du trafic)", async () => {
    mockedRedisInstance.pipeline.mockImplementation(() => {
      throw new Error("network down");
    });
    const result = await rateLimitDistributed("test:panne", { limit: 3, windowMs: 60_000 });
    expect(result.allowed).toBe(true);
    expect(result.distributed).toBe(false);
  });

  it("compte les requêtes successives (incr cumulatif)", async () => {
    activerRedisSimule();
    let counter = 0;
    mockedRedisInstance.pipeline.mockReturnValue({
      incr: vi.fn().mockReturnThis(),
      pexpire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockImplementation(async () => {
        counter += 1;
        return [counter, 1];
      }),
    });
    const first = await rateLimitDistributed("test:cumul", { limit: 3, windowMs: 60_000 });
    const second = await rateLimitDistributed("test:cumul", { limit: 3, windowMs: 60_000 });
    const third = await rateLimitDistributed("test:cumul", { limit: 3, windowMs: 60_000 });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(true);
    expect(second.remaining).toBe(1);
    expect(third.remaining).toBe(0);
  });
});

describe("cacheWrap — chemin heureux avec Redis", () => {
  it("sert le cache au second appel (hit)", async () => {
    activerRedisSimule();
    mockedRedisInstance.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ v: 42 });
    mockedRedisInstance.set.mockResolvedValue("OK");
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { v: 42 };
    };
    const first = await cacheWrap("k:cache", 60, loader);
    const second = await cacheWrap("k:cache", 60, loader);
    expect(first.hit).toBe(false);
    expect(second.hit).toBe(true);
    expect(second.value).toEqual({ v: 42 });
    expect(calls).toBe(1);
  });

  it("cacheSet persiste avec TTL borné", async () => {
    activerRedisSimule();
    mockedRedisInstance.set.mockResolvedValue("OK");
    await cacheSet("k:ttl", { a: 1 }, 30);
    expect(mockedRedisInstance.set).toHaveBeenCalledWith(
      expect.stringContaining("k:ttl"),
      { a: 1 },
      { ex: 30 },
    );
  });

  it("cacheDelete délègue au client", async () => {
    activerRedisSimule();
    mockedRedisInstance.del.mockResolvedValue(1);
    await expect(cacheDelete("k:del")).resolves.toBe(true);
  });
});

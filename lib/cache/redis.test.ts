import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cache process-local (Task 108 — lib/cache/redis.ts réimplémenté EN
 * MÉMOIRE, API historique conservée) : TTL, éviction LRU (plafond clés +
 * budget mémoire), cache-aside (cacheWrap), rate limit fenêtre fixe
 * PAR-INSTANCE et sonde `redisPing` toujours verte.
 */

import {
  REDIS_CACHE_TTL_SECONDS,
  cacheDelete,
  cacheGet,
  cacheSet,
  cacheWrap,
  getRedis,
  isRedisConfigured,
  rateLimitDistributed,
  redisPing,
  resetRedisClientForTests,
} from "./redis";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  resetRedisClientForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("état de la couche", () => {
  it("est toujours configurée et répond au ping (process-local)", async () => {
    expect(isRedisConfigured()).toBe(true);
    await expect(redisPing()).resolves.toBe(true);
    // L'API brute n'existe plus : getRedis reste exporté à null (compat).
    expect(getRedis()).toBeNull();
  });
});

describe("cacheGet / cacheSet / cacheDelete", () => {
  it("stocke puis relit une valeur structurée", async () => {
    await expect(cacheGet("cle:absente")).resolves.toBeNull();
    await expect(cacheSet("cle:1", { a: 1, b: ["x"] })).resolves.toBe(true);
    await expect(cacheGet("cle:1")).resolves.toEqual({ a: 1, b: ["x"] });
  });

  it("respecte le TTL par défaut (600 s) : hit avant, null après", async () => {
    await cacheSet("cle:ttl", "valeur");
    vi.advanceTimersByTime(REDIS_CACHE_TTL_SECONDS * 1000 - 1_000);
    await expect(cacheGet("cle:ttl")).resolves.toBe("valeur");
    vi.advanceTimersByTime(2_000);
    await expect(cacheGet("cle:ttl")).resolves.toBeNull();
  });

  it("TTL explicite : 2 s, purge à l'expiration", async () => {
    await cacheSet("cle:court", 42, 2);
    vi.advanceTimersByTime(1_500);
    await expect(cacheGet("cle:court")).resolves.toBe(42);
    vi.advanceTimersByTime(1_000);
    await expect(cacheGet("cle:court")).resolves.toBeNull();
  });

  it("cacheDelete invalide immédiatement (invalidation événementielle)", async () => {
    await cacheSet("cle:del", "x");
    await expect(cacheDelete("cle:del")).resolves.toBe(true);
    await expect(cacheGet("cle:del")).resolves.toBeNull();
    await expect(cacheDelete("cle:del")).resolves.toBe(false);
  });

  it("le TTL est rafraîchi par une réécriture (pas d'expiration anticipée)", async () => {
    await cacheSet("cle:refresh", "v1", 10);
    vi.advanceTimersByTime(9_000);
    await cacheSet("cle:refresh", "v2", 10);
    vi.advanceTimersByTime(9_000);
    await expect(cacheGet("cle:refresh")).resolves.toBe("v2");
  });
});

describe("éviction (plafonds bornés)", () => {
  it("éviction LRU au-delà du plafond de clés : les plus anciennes sortent", async () => {
    // Plafond interne : 5 000 clés. On en insère 5 010.
    for (let i = 0; i < 5_010; i += 1) {
      await cacheSet(`k:${i}`, i, 600);
    }
    // Les 10 premières (les plus anciennes) ont été évincées.
    await expect(cacheGet("k:0")).resolves.toBeNull();
    await expect(cacheGet("k:9")).resolves.toBeNull();
    // Les récentes sont intactes.
    await expect(cacheGet("k:5009")).resolves.toBe(5009);
  });

  it("la RÉCENCE protège une clé lue : lecture = rafraîchissement LRU", async () => {
    for (let i = 0; i < 5_000; i += 1) {
      await cacheSet(`k:${i}`, i, 600);
    }
    // On lit la plus ancienne : elle redevient la plus récente.
    await cacheGet("k:0");
    // Une nouvelle entrée pousse la suivante (k:1) hors du cache, pas k:0.
    await cacheSet("k:nouvelle", "n", 600);
    await expect(cacheGet("k:0")).resolves.toBe(0);
    await expect(cacheGet("k:1")).resolves.toBeNull();
  });

  it("budget mémoire : une valeur hors budget (~50 Mo) est refusée, jamais stockée", async () => {
    const huge = "x".repeat(50 * 1024 * 1024 + 1);
    await expect(cacheSet("k:huge", huge, 600)).resolves.toBe(false);
    await expect(cacheGet("k:huge")).resolves.toBeNull();
  });

  it("les valeurs expirées libèrent le budget sans éviction des chaudes", async () => {
    for (let i = 0; i < 5_000; i += 1) {
      await cacheSet(`e:${i}`, i, 1); // TTL 1 s
    }
    vi.advanceTimersByTime(2_000); // toutes expirées
    await cacheSet("e:frais", "ok", 600);
    await expect(cacheGet("e:frais")).resolves.toBe("ok");
  });
});

describe("cacheWrap (cache-aside)", () => {
  it("miss → loader → set ; hit suivant sans loader", async () => {
    const loader = vi.fn(async () => ({ items: [1, 2, 3] }));
    const first = await cacheWrap("wrap:1", 60, loader);
    expect(first).toEqual({ value: { items: [1, 2, 3] }, hit: false });
    const second = await cacheWrap("wrap:1", 60, loader);
    expect(second).toEqual({ value: { items: [1, 2, 3] }, hit: true });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("un résultat null/undefined n'est PAS stocké (loader rappelé)", async () => {
    const loader = vi.fn(async () => null as unknown as string);
    await cacheWrap("wrap:null", 60, loader);
    await cacheWrap("wrap:null", 60, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("expire après le TTL fourni (loader ré-exécuté)", async () => {
    const loader = vi.fn(async () => "valeur");
    await cacheWrap("wrap:ttl", 5, loader);
    vi.advanceTimersByTime(6_000);
    await cacheWrap("wrap:ttl", 5, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("rateLimitDistributed (fenêtre fixe PAR-INSTANCE)", () => {
  it("laisse passer jusqu'à `limit`, puis refuse avec retryAfterMs", async () => {
    for (let i = 0; i < 3; i += 1) {
      const result = await rateLimitDistributed("rl:a", { limit: 3, windowMs: 60_000 });
      expect(result.allowed).toBe(true);
      expect(result.distributed).toBe(false);
    }
    const refused = await rateLimitDistributed("rl:a", { limit: 3, windowMs: 60_000 });
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("la fenêtre se réouvre après expiration (reset exact au premier hit)", async () => {
    await rateLimitDistributed("rl:b", { limit: 1, windowMs: 10_000 });
    expect((await rateLimitDistributed("rl:b", { limit: 1, windowMs: 10_000 })).allowed).toBe(false);
    vi.advanceTimersByTime(10_001);
    const again = await rateLimitDistributed("rl:b", { limit: 1, windowMs: 10_000 });
    expect(again.allowed).toBe(true);
    expect(again.remaining).toBe(0);
  });

  it("clés indépendantes + remaining décroissant", async () => {
    const first = await rateLimitDistributed("rl:c1", { limit: 5, windowMs: 60_000 });
    const second = await rateLimitDistributed("rl:c2", { limit: 5, windowMs: 60_000 });
    expect(first.remaining).toBe(4);
    expect(second.remaining).toBe(4);
    const third = await rateLimitDistributed("rl:c1", { limit: 5, windowMs: 60_000 });
    expect(third.remaining).toBe(3);
  });
});

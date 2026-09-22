/**
 * Client Redis Upstash (REST) — socle de cache et de compteurs partagés.
 *
 * Pourquoi Upstash REST : le runtime serverless Vercel ne garde aucune
 * connexion TCP persistante entre les invocations ; le protocole REST
 * d'Upstash (HTTPS) est le seul mode fiable dans ce contexte. Le client
 * officiel @upstash/redis gère automatiquement le pipeline, les retries
 * et la désérialisation JSON.
 *
 * Règles de conception :
 *  - Dégradation gracieuse : si UPSTASH_REDIS_REST_URL/TOKEN sont absents
 *    ou si le service ne répond pas, chaque fonction retourne une valeur
 *    neutre (null / false) — les appelants DOIVENT avoir un repli local
 *    (ex. rate-limit en mémoire, cache processe). Redis est une couche
 *    d'accélération, jamais une dépendance dure.
 *  - Préfixe de clés unique `g3:` pour cohabiter proprement avec d'autres
 *    usages éventuels de la même base.
 */

import { Redis } from "@upstash/redis";

const KEY_PREFIX = "g3:";

let redisClient: Redis | null = null;
let clientInitialised = false;

function buildClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  try {
    return new Redis({ url, token, automaticDeserialization: true });
  } catch {
    return null;
  }
}

/** Client partagé, ou null si Redis n'est pas configuré. */
export function getRedis(): Redis | null {
  if (!clientInitialised) {
    redisClient = buildClient();
    clientInitialised = true;
  }
  return redisClient;
}

export function isRedisConfigured(): boolean {
  return getRedis() !== null;
}

/**
 * @internal Réservé aux tests : réinitialise le singleton client afin de
 * re-évaluer la configuration d'environnement entre les scénarios.
 */
export function resetRedisClientForTests(): void {
  redisClient = null;
  clientInitialised = false;
}

function prefixed(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

/** Durée de vie par défaut des entrées de cache (10 minutes). */
export const REDIS_CACHE_TTL_SECONDS = 600;

/**
 * Lit une valeur JSON du cache. Retourne null si Redis est absent,
 * en erreur, ou si la clé n'existe pas.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const value = await redis.get<T>(prefixed(key));
    return (value ?? null) as T | null;
  } catch {
    return null;
  }
}

/**
 * Écrit une valeur JSON avec TTL (secondes). Retourne true en cas de succès,
 * false si Redis est absent ou en erreur (l'appelant continue sans cache).
 */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds = REDIS_CACHE_TTL_SECONDS,
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.set(prefixed(key), value as never, { ex: Math.max(1, Math.floor(ttlSeconds)) });
    return true;
  } catch {
    return false;
  }
}

/** Supprime une clé (invalidation). Retourne true si la clé a été supprimée. */
export async function cacheDelete(key: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.del(prefixed(key));
    return true;
  } catch {
    return false;
  }
}

/**
 * Wrapper cache-aside : sert la valeur en cache si présente, sinon exécute
 * le loader, stocke le résultat (TTL) et le retourne. Si Redis est absent
 * ou en erreur, le loader est simplement exécuté à chaque fois.
 */
export async function cacheWrap<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<{ value: T; hit: boolean }> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) return { value: cached, hit: true };
  const value = await loader();
  // On stocke même un résultat "falsy" tant qu'il est définissable : null
  // reste réservé à l'absence d'entrée.
  if (value !== null && value !== undefined) {
    await cacheSet(key, value, ttlSeconds);
  }
  return { value, hit: false };
}

export interface DistributedRateLimitResult {
  allowed: boolean;

  remaining: number;

  retryAfterMs: number;

  /** true si la décision vient de Redis (partagée), false du repli local. */
  distributed: boolean;
}

interface LocalLimitEntry {
  count: number;

  resetAt: number;
}

/**
 * Compteur local de repli (une instance serverless). Volontairement minimal :
 * il ne sert QUE lorsque Redis est absent/indisponible, afin de conserver
 * une protection même dégradée.
 */
const localStore = new Map<string, LocalLimitEntry>();
const LOCAL_STORE_MAX_ENTRIES = 10_000;

function localRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): DistributedRateLimitResult {
  const now = Date.now();

  if (localStore.size >= LOCAL_STORE_MAX_ENTRIES) {
    for (const [entryKey, entry] of localStore) {
      if (entry.resetAt <= now) localStore.delete(entryKey);
    }
  }

  const existing = localStore.get(key);
  if (!existing || existing.resetAt <= now) {
    localStore.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterMs: 0, distributed: false };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return { allowed: false, remaining: 0, retryAfterMs: existing.resetAt - now, distributed: false };
  }
  return { allowed: true, remaining: limit - existing.count, retryAfterMs: 0, distributed: false };
}

/**
 * Rate limit DISTRIBUÉ (fenêtre fixe atomique) partagé par toutes les
 * instances serverless. Implémentation : INCR puis PEXPIRE posé à chaque
 * appel (O(1) côté Redis et auto-réparation d'une clé orpheline sans
 * expiration), envoyés en pipeline Upstash pour limiter les allers-retours.
 *
 * En cas d'absence ou d'échec Redis : repli transparent sur le compteur
 * local, avec `distributed: false` pour permettre l'observabilité.
 */
export async function rateLimitDistributed(
  key: string,
  config: { limit: number; windowMs: number },
): Promise<DistributedRateLimitResult> {
  const redis = getRedis();
  if (!redis) return localRateLimit(key, config.limit, config.windowMs);

  const redisKey = prefixed(`rl:${key}`);

  try {
    const [count] = await redis
      .pipeline()
      .incr(redisKey)
      .pexpire(redisKey, Math.max(1, config.windowMs))
      .exec();

    const current = typeof count === "number" ? count : Number(count ?? 1);

    if (current === 1) {
      return { allowed: true, remaining: config.limit - 1, retryAfterMs: 0, distributed: true };
    }

    if (current > config.limit) {
      // Fenêtre fixe : la clé expire windowMs après le premier hit. Le TTL
      // résiduel donne le reset exact ; en cas d'échec de lecture, on
      // estime par la fenêtre complète (défaut sûr).
      let ttlMs = config.windowMs;
      try {
        const ttl = await redis.pttl(redisKey);
        if (typeof ttl === "number" && ttl > 0) ttlMs = ttl;
      } catch {
        // TTL indisponible : estimation par défaut.
      }
      return { allowed: false, remaining: 0, retryAfterMs: ttlMs, distributed: true };
    }

    return {
      allowed: true,
      remaining: config.limit - current,
      retryAfterMs: 0,
      distributed: true,
    };
  } catch {
    // Redis indisponible : ne JAMAIS bloquer le trafic pour autant.
    return localRateLimit(key, config.limit, config.windowMs);
  }
}

/** Ping applicatif (health checks / diagnostics). */
export async function redisPing(): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const result = await redis.ping();
    return result === "PONG";
  } catch {
    return false;
  }
}

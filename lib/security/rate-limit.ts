interface RateLimitEntry {
  count: number;

  resetAt: number;
}

const store =
  new Map<string, RateLimitEntry>();

export interface RateLimitConfig {
  limit: number;

  windowMs: number;
}

const MAX_STORE_ENTRIES = 10_000;

function nettoyerEntreesExpirees(now: number): void {
  // Sans éviction, la Map croît indéfiniment entre les cold starts :
  // fuite mémoire lente sur les instances longues.
  if (store.size < MAX_STORE_ENTRIES) return;
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}

export function rateLimit(
  key: string,
  config: RateLimitConfig,
): {
  allowed: boolean;

  remaining: number;

  retryAfterMs: number;
} {
  const now =
    Date.now();

  nettoyerEntreesExpirees(now);

  const existing =
    store.get(key);

  if (
    !existing ||
    existing.resetAt <= now
  ) {
    store.set(key, {
      count: 1,

      resetAt:
        now + config.windowMs,
    });

    return {
      allowed: true,

      remaining:
        config.limit - 1,

      retryAfterMs: 0,
    };
  }

  existing.count++;

  if (
    existing.count >
    config.limit
  ) {
    return {
      allowed: false,

      remaining: 0,

      retryAfterMs:
        existing.resetAt - now,
    };
  }

  return {
    allowed: true,

    remaining:
      config.limit -
      existing.count,

    retryAfterMs: 0,
  };
}

/** Meilleure identification client possible derriere le proxy Vercel. */
export function clientIp(request: Request): string {
  // x-real-ip est posé par la plateforme Vercel depuis la connexion TCP :
  // non falsifiable par le client. x-forwarded-for n'est consulté qu'en
  // repli (le premier hop peut être forgé par le client).
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}

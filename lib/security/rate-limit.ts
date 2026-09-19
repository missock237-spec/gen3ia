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
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

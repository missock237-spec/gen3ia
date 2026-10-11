import { RateLimiterRedis } from 'rate-limiter-flexible';
import Redis from 'ioredis';

const redisClient = new Redis(process.env.REDIS_URL);

// Rate limiter par utilisateur avec paliers progressifs
export const rateLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: 'gen3ia_rl',
  points: 100,        // 100 requêtes
  duration: 60,       // par minute
  blockDuration: 300, // blocage 5 min si dépassé
});

// Rate limiter strict pour les endpoints IA (coûteux)
export const aiRateLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: 'gen3ia_ai_rl',
  points: 20,         // 20 appels IA
  duration: 3600,     // par heure
  blockDuration: 3600,
});

export async function checkRateLimit(userId: string, isAI: boolean = false) {
  const limiter = isAI ? aiRateLimiter : rateLimiter;
  try {
    await limiter.consume(userId);
    return { allowed: true, remaining: limiter.points };
  } catch (rejRes) {
    return {
      allowed: false,
      remaining: rejRes.remainingPoints || 0,
      retryAfter: Math.ceil((rejRes.msBeforeNext || 0) / 1000),
    };
  }
}

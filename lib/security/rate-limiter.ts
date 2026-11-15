import "server-only";

import { enforceRateLimit } from "@/lib/security/rate-limit";

/**
 * RATE LIMITER PAR UTILISATEUR — paliers progressifs (intentions du commit
 * 9c3afc4 « rate limiter using Redis », intégrées à l'architecture Gen3ia).
 *
 * Correctif d'intégration (Task 127) : le module d'origine importait
 * `rate-limiter-flexible` + `ioredis` (non installés — le projet n'a pas de
 * Redis dédié) et ne compilait pas (rejRes inconnu). L'INTENTION est
 * conservée — deux budgets distincts utilisateurs/IA avec blocage
 * progressif — au-dessus du mécanisme EXISTANT de la plateforme
 * (lib/security/rate-limit.ts : double couche locale + distribuée),
 * déjà éprouvé en production (quota 100 req/min/utilisateur, Task 108+).
 */

/** Budget standard : actions utilisateur (consultations, écritures). */
export const USER_RATE_LIMIT = { limit: 100, windowMs: 60_000 } as const;

/** Budget strict : appels IA coûteux (générations, agents). */
export const AI_RATE_LIMIT = { limit: 20, windowMs: 3_600_000 } as const;

export interface RateLimitCheck {
  allowed: boolean;
  remaining: number;
  /** Secondes avant nouvelle tentative (0 si autorisé). */
  retryAfter: number;
}

/** Vérifie le budget d'un utilisateur (budget IA si isAI). */
export async function checkRateLimit(userId: string, isAI = false): Promise<RateLimitCheck> {
  const config = isAI ? AI_RATE_LIMIT : USER_RATE_LIMIT;
  const result = await enforceRateLimit(`owner:${userId}:${isAI ? "ai" : "user"}`, config);
  return {
    allowed: result.allowed,
    remaining: result.remaining,
    retryAfter: result.allowed ? 0 : Math.ceil((result.retryAfterMs ?? 60_000) / 1000),
  };
}

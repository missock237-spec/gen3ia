import {
  rateLimitDistributed,
} from "@/lib/cache/redis";

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

export interface EnforcedRateLimitResult {
  allowed: boolean;

  remaining: number;

  retryAfterMs: number;

  /**
   * true si une couche partagée a été consultée. DEPUIS Task 108
   * (suppression du service Redis externe) : la couche 2 est PAR-INSTANCE
   * (fenêtre fixe en mémoire) — ce drapeau ne vaut plus « décision
   * globalement atomique », mais « deuxième fenêtre indépendante
   * consultée ». Périmètre réel : une instance (PM2 fork unique sur le
   * VPS) → limite globalement exacte ; si l'application redevenait
   * multi-instances un jour, le facteur = nombre d'instances chaudes
   * (rétablir alors un store partagé — voir lib/cache/redis.ts).
   */
  distributed: boolean;
}

/**
 * Rate limit RENFORCÉ à utiliser dans les routes API : combine la décision
 * locale (instantanée, couche 1) et une deuxième fenêtre fixe (couche 2).
 *
 * Historique : la couche 2 était une fenêtre Redis partagée entre toutes
 * les instances serverless. DEPUIS Task 108 (suppression du service Redis
 * externe), elle est PAR-INSTANCE (lib/cache/redis.ts) — la combinaison
 * garde un intérêt (deux fenêtres indépendantes, dont une à fenêtre fixe
 * qui résiste au contournement par rafales de la couche glissante locale),
 * mais le quota n'est PLUS globalement atomique entre instances. Sur le
 * déploiement actuel (PM2 fork, UNE instance app) c'est équivalent ; en
 * multi-instances, le facteur de multiplication = instances chaudes.
 *
 * Réapprovisionnement du résultat :
 *  - `allowed`    : les DEUX couches doivent autoriser ;
 *  - `retryAfterMs` : la fenêtre la plus contraignante ;
 *  - `remaining`  : le quota restant le plus faible ;
 *  - `distributed`: true dès que la couche 2 a été consultée (par-instance
 *    depuis Task 108 — voir le doc de ce champ).
 *
 * Échec de la couche 2 : repli transparent sur la décision locale
 * uniquement (jamais de blocage du trafic légitime pour une panne).
 */
export async function enforceRateLimit(
  key: string,
  config: RateLimitConfig,
): Promise<EnforcedRateLimitResult> {
  // Couche 1 — locale : réponse immédiate, protège aussi l'instance courante
  // lorsque Redis rame (latence réseau) sans attendre l'aller-retour HTTPS.
  const local = rateLimit(key, config);

  // Couche 2 — distribuée : compteur partagé entre instances.
  const distributed = await rateLimitDistributed(key, config);

  const allowed = local.allowed && distributed.allowed;
  const retryAfterMs = Math.max(
    local.allowed ? 0 : local.retryAfterMs,
    distributed.allowed ? 0 : distributed.retryAfterMs,
  );
  const remaining = Math.min(local.remaining, distributed.remaining);

  if (!allowed) {
    // On conserve la trace locale : elle sert aux diagnostics de charge.
    return { allowed: false, remaining: 0, retryAfterMs, distributed: distributed.distributed };
  }

  return { allowed: true, remaining, retryAfterMs: 0, distributed: distributed.distributed };
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

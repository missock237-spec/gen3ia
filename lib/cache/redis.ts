/**
 * Cache process-local — socle de cache et de compteurs (API historique).
 *
 * Task 108 — SUPPRESSION DU SERVICE EXTERNE REDIS : le cache et les
 * compteurs sont PROCESSUS-LOCAL depuis la suppression du service externe
 * Redis (décision worklog 108-0 — Firestore unique moteur + R2 objets). La
 * Map process n'est PAS partagée entre les instances serverless :
 *   - le cache-aside (`cacheWrap`) reste par-instance par nature — un cold
 *     start repart d'un cache vide, exactement comme le repli local
 *     historique quand le service externe était absent/indisponible ;
 *   - le rate limit (`rateLimitDistributed`) redevient PAR-INSTANCE
 *     (fenêtre fixe en mémoire) — la protection reste réelle par instance,
 *     le facteur de multiplication = nombre d'instances chaudes.
 * Le nom du module et TOUTES les signatures exportées sont conservés à
 * l'identique : les consommateurs ne changent pas.
 *
 * Règles de conception (conservées) :
 *  - Dégradation gracieuse : aucune fonction ne lève — une entrée expirée,
 *    une valeur manquante ou un incident retourne une valeur neutre
 *    (null / false) ; les appelants DOIVENT avoir un repli local (ex.
 *    rate-limit mémoire, relecture Firestore). Le cache est une couche
 *    d'accélération, jamais une dépendance dure.
 *  - Préfixe de clés unique `g3:` conservé pour la lisibilité des clés et
 *    la cohabitation avec d'autres usages éventuels.
 *  - Borné : plafond de 5 000 clés LRU ET budget mémoire ~50 Mo — aucune
 *    croissance indéfinie entre deux cold starts.
 */

const KEY_PREFIX = "g3:";

/** Durée de vie par défaut des entrées de cache (10 minutes). */
export const REDIS_CACHE_TTL_SECONDS = 600;

// ---------------------------------------------------------------------------
// Store mémoire : Map TTL + LRU (insertion en fin, récence rafraîchie à la
// lecture, éviction des plus anciennes au-delà des plafonds)
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: unknown;

  expiresAt: number;

  /** Taille approximative de la valeur (octets JSON) — budget mémoire. */
  sizeBytes: number;
}

const cache = new Map<string, CacheEntry>();

/** Plafond d'ENTRÉES (clés) du cache process-local. */
const CACHE_MAX_ENTRIES = 5_000;

/** Budget MÉMOIRE approximatif du cache process-local (~50 Mo). */
const CACHE_MAX_BYTES = 50 * 1024 * 1024;

let cacheTotalBytes = 0;

/** Taille JSON approximative d'une valeur (borne défensive : jamais throw). */
function approximateSizeBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized ? serialized.length : 8;
  } catch {
    // Valeur non sérialisable (cycle…) : taille forfaitaire, elle ne sera
    // jamais relue par cacheGet (qui re-JSONifie) mais reste bornée.
    return 1024;
  }
}

function evictIfNeeded(): void {
  // Expirées d'abord (coût faible, libère le budget sans perdre de chaudes).
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
      cacheTotalBytes -= entry.sizeBytes;
    }
  }
  // Puis LRU strict (la Map est ordonnée par récence).
  while (cache.size > CACHE_MAX_ENTRIES || cacheTotalBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const entry = cache.get(oldest);
    cache.delete(oldest);
    if (entry) cacheTotalBytes -= entry.sizeBytes;
  }
}

function cacheGetSync(key: string): { found: boolean; value: unknown } {
  try {
    const entry = cache.get(key);
    if (!entry) return { found: false, value: null };
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      cacheTotalBytes -= entry.sizeBytes;
      return { found: false, value: null };
    }
    // Rafraîchit la récence (Map LRU par ordre d'insertion).
    cache.delete(key);
    cache.set(key, entry);
    return { found: true, value: entry.value };
  } catch {
    return { found: false, value: null };
  }
}

function cacheSetSync(key: string, value: unknown, ttlSeconds: number): boolean {
  try {
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    const sizeBytes = approximateSizeBytes(value);
    // Une valeur hors budget ne peut jamais être stockée sans casser le
    // plafond : on refuse silencieusement (l'appelant continue sans cache).
    if (sizeBytes > CACHE_MAX_BYTES) return false;
    const previous = cache.get(key);
    if (previous) cacheTotalBytes -= previous.sizeBytes;
    cache.delete(key);
    cache.set(key, { value, expiresAt: Date.now() + ttl * 1000, sizeBytes });
    cacheTotalBytes += sizeBytes;
    // Éviction APRÈS insertion : l'entrée fraîche est la plus récente (queue
    // de la Map), le LRU purge les plus anciennes pour revenir sous plafond.
    evictIfNeeded();
    return true;
  } catch {
    return false;
  }
}

function cacheDeleteSync(key: string): boolean {
  const previous = cache.get(key);
  const existed = cache.delete(key);
  if (previous) cacheTotalBytes -= previous.sizeBytes;
  return existed;
}

// ---------------------------------------------------------------------------
// API publique (signatures conservées à l'identique)
// ---------------------------------------------------------------------------

/**
 * L'API brute Redis n'existe plus (Task 108) : il n'y a plus de client à
 * exposer. Les consommateurs de bas niveau utilisent les helpers cache*.
 * @internal Conservé pour compat d'import historique — retourne toujours null.
 */
export function getRedis(): null {
  return null;
}

/** Le cache process-local est TOUJOURS disponible (Task 108). */
export function isRedisConfigured(): boolean {
  return true;
}

/**
 * @internal Réservé aux tests : réinitialise le store ET le compteur de
 * rate limit afin de repartir d'un état neutre entre les scénarios.
 */
export function resetRedisClientForTests(): void {
  cache.clear();
  cacheTotalBytes = 0;
  rateLimitStore.clear();
}

/**
 * Lit une valeur du cache. Retourne null si la clé n'existe pas ou est
 * expirée.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const { found, value } = cacheGetSync(`${KEY_PREFIX}${key}`);
  return found ? (value as T) : null;
}

/**
 * Écrit une valeur avec TTL (secondes). Retourne true en cas de succès,
 * false si la valeur est hors budget (l'appelant continue sans cache).
 */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds = REDIS_CACHE_TTL_SECONDS,
): Promise<boolean> {
  return cacheSetSync(`${KEY_PREFIX}${key}`, value, ttlSeconds);
}

/**
 * Supprime une clé (invalidation événementielle : sonnette notifications,
 * quotas Gen…). Retourne true si la clé existait.
 */
export async function cacheDelete(key: string): Promise<boolean> {
  return cacheDeleteSync(`${KEY_PREFIX}${key}`);
}

/**
 * Wrapper cache-aside : sert la valeur en cache si présente, sinon exécute
 * le loader, stocke le résultat (TTL) et le retourne.
 *
 * Le loader n'est exécuté qu'au premier appel par clé et par instance —
 * les appels suivants dans la fenêtre TTL sont servis depuis la mémoire.
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

  /**
   * false depuis Task 108 : la décision est PAR-INSTANCE (plus de vérité
   * partagée entre instances). Conservé pour l'observabilité existante.
   */
  distributed: boolean;
}

interface RateLimitEntry {
  count: number;

  resetAt: number;
}

/**
 * Compteur de rate limit process-local (fenêtre fixe atomique par instance —
 * Node mono-thread, aucune course). Plafonné (10 000 clés) avec purge des
 * fenêtres expirées : aucune croissance indéfinie entre deux cold starts.
 */
const rateLimitStore = new Map<string, RateLimitEntry>();
const RATE_LIMIT_MAX_ENTRIES = 10_000;

/**
 * Rate limit (fenêtre fixe) — PAR-INSTANCE depuis Task 108. Le TTL de la
 * fenêtre démarre au premier hit (auto-réparation d'une clé orpheline) et
 * le reset exact est calculé depuis l'instant d'ouverture de la fenêtre.
 */
export async function rateLimitDistributed(
  key: string,
  config: { limit: number; windowMs: number },
): Promise<DistributedRateLimitResult> {
  const prefixed = `${KEY_PREFIX}rl:${key}`;
  const now = Date.now();

  if (rateLimitStore.size >= RATE_LIMIT_MAX_ENTRIES) {
    for (const [entryKey, entry] of rateLimitStore) {
      if (entry.resetAt <= now) rateLimitStore.delete(entryKey);
    }
  }

  const existing = rateLimitStore.get(prefixed);
  if (!existing || existing.resetAt <= now) {
    rateLimitStore.set(prefixed, { count: 1, resetAt: now + config.windowMs });
    return { allowed: true, remaining: config.limit - 1, retryAfterMs: 0, distributed: false };
  }

  existing.count += 1;
  if (existing.count > config.limit) {
    // Fenêtre fixe : la clé expire windowMs après le premier hit.
    return { allowed: false, remaining: 0, retryAfterMs: existing.resetAt - now, distributed: false };
  }
  return {
    allowed: true,
    remaining: config.limit - existing.count,
    retryAfterMs: 0,
    distributed: false,
  };
}

/**
 * Ping applicatif (health checks / diagnostics) : le store mémoire répond
 * TOUJOURS — la sonde d'infrastructure reste verte (Task 108 : la couche de
 * cache est process-local, il n'y a plus de service distant à joindre).
 */
export async function redisPing(): Promise<boolean> {
  return true;
}

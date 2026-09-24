/**
 * Garde-fous de sécurité SANS dépendance Node — utilisables dans le proxy
 * (runtime Edge) comme dans les routes API et les tests unitaires.
 *
 * 1. `crossSiteMutationVerdict` : barrière CSRF centrale. Toute requête
 *    modifiant l'état (POST/PUT/PATCH/DELETE) vers /api/* émise par un
 *    navigateur depuis une AUTRE origine est refusée avant même d'atteindre
 *    la route. Gen3ia n'expose aucun CORS : aucun client légitime ne fait
 *    d'appel cross-origin depuis un navigateur.
 *    Les appels serveur à serveur (webhooks, SDK, cron) n'envoient ni Origin
 *    ni Sec-Fetch-Site : ils ne sont pas concernés et restent authentifiés
 *    par signature / Bearer dans leurs routes.
 *
 * 2. `timingSafeEqualString` : comparaison de secrets à temps constant
 *    (évite qu'un attaquant devine un secret caractère par caractère en
 *    mesurant le temps de réponse).
 */

export const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Préfixes d'API volontairement joignables hors navigateur de l'application :
 * webhooks signés (paiement, déclencheurs d'agents), fournisseurs voix
 * (Twilio/Plivo), API publique des agents clients.
 */
export const CROSS_SITE_EXEMPT_PREFIXES: readonly string[] = [
  "/api/webhooks/",
  "/api/voice/",
  "/api/public/",
  "/api/security/csp-report",
];

export type CrossSiteVerdict =
  | { allowed: true }
  | { allowed: false; reason: "cross-site-fetch" | "origin-mismatch" };

interface MinimalRequest {
  method: string;
  pathname: string;
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Décision CSRF pour une requête /api/*.
 * - `Sec-Fetch-Site: cross-site` (navigateurs modernes, non falsifiable par JS) → refus ;
 * - sinon, un en-tête Origin présent DOIT correspondre à l'hôte (ou à une origine autorisée).
 * `Origin: null` (iframe sandboxée, redirection opaque) est traité comme étranger.
 */
export function crossSiteMutationVerdict(
  request: MinimalRequest,
  allowedOrigins: readonly string[] = [],
): CrossSiteVerdict {
  if (!STATE_CHANGING_METHODS.has(request.method.toUpperCase())) return { allowed: true };
  if (!request.pathname.startsWith("/api/")) return { allowed: true };
  if (CROSS_SITE_EXEMPT_PREFIXES.some((prefix) => request.pathname.startsWith(prefix))) return { allowed: true };

  if (request.secFetchSite?.toLowerCase() === "cross-site") {
    return { allowed: false, reason: "cross-site-fetch" };
  }

  const origin = request.origin?.trim();
  if (!origin) return { allowed: true };

  const originHost = origin === "null" ? null : hostOf(origin);
  const host = request.host?.toLowerCase() ?? null;
  if (originHost && host && originHost === host) return { allowed: true };
  if (originHost && allowedOrigins.some((allowed) => hostOf(allowed) === originHost)) return { allowed: true };

  return { allowed: false, reason: "origin-mismatch" };
}

/** Comparaison de chaînes à temps constant (longueur incluse dans l'accumulateur). */
export function timingSafeEqualString(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string" || b.length === 0) return false;
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index++) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

/** Origines supplémentaires de confiance (domaine canonique de production). */
export function trustedOriginsFromEnv(env: Record<string, string | undefined>): string[] {
  return [env.NEXT_PUBLIC_SITE_URL, env.NEXT_PUBLIC_APP_URL]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

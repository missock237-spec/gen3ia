import { createHash } from "node:crypto";

/**
 * Utilitaires de performance pour GET /api/integrations/catalog (Task 25-g).
 *
 * Pourquoi ce module : la route catalogue était le goulot unique de la
 * plateforme (P50 1 149 ms, payload 380 Ko, pics 6,2 s — audit 25-e). Les
 * leviers retenus sont :
 *  1. cache-aside Redis d'une enveloppe PRÊTE À SERVIR ({ etag, body }) par
 *     variante de requête (limit / catégorie / recherche) — plus aucune
 *     re-sérialisation ni re-filtrage sur les hits ;
 *  2. ETag fort (SHA-256 du corps) + If-None-Match → 304 : zéro octet de
 *     payload lorsque le client a déjà la version courante ;
 *  3. payload réduit : seuls les champs réellement consommés par le front
 *     (toolkit, label, description tronquée, logo, category, auth) sont
 *     renvoyés — `categories`, `authSchemes` et `managedBy` (jamais lus côté
 *     UI) sont supprimés, description plafonnée à ~140 caractères.
 *
 * Ce module est purement fonctionnel (aucune I/O, aucun effet de bord) afin
 * d'être testable unitairement et importable sans dépendance lourde.
 */

/**
 * Version du schéma de cache. INCRÉMENTER pour invalider instantanément
 * toutes les entrées en production (anciennes clés orphelines expirées par
 * TTL, sans code de migration).
 */
export const CATALOG_CACHE_VERSION = "v3";

/**
 * TTL des réponses catalogues en cache (5 minutes) : le catalogue Composio
 * change rarement (nouveaux toolkits), 5 min borne l'obsolescence tout en
 * absorbant les rafales.
 */
export const CATALOG_CACHE_TTL_SECONDS = 300;

/** Longueur maximale des descriptions envoyées au client (troncature « … »). */
export const CATALOG_DESCRIPTION_MAX_CHARS = 140;

/**
 * Enveloppe sérialisée stockée en cache : le corps JSON exact de la réponse
 * et son ETag fort. Stocker la chaîne (et non l'objet) évite de re-sérialiser
 * ~250 Ko à chaque requête et garantit la stabilité byte-à-byte de l'ETag.
 */
export interface CatalogResponseEnvelope {
  etag: string;
  body: string;
}

/** Hash court et stable d'une valeur de recherche (16 hexadécimaux). */
function hashRecherche(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

/**
 * Construit la clé de cache versionnée d'une variante du catalogue :
 * `catalog:<version>:<limit>:<category|all>:<q-hash|none>`.
 *
 * Le module Redis (lib/cache/redis) préfixe déjà les clés avec `g3:`.
 * - `limit` : borné en amont par la route (1..5000) ; valeur non finie →
 *   repli sur 1000 (défaut de la route) pour ne jamais produire de clé `NaN`.
 * - `search` : trim + minuscules AVANT hash — la route filtre elle-même en
 *   minuscules, donc « GitHub » et « github » produisent le MÊME corps et
 *   doivent partager la même entrée de cache.
 * - `category` : conservée telle quelle (trim) — le filtre serveur compare
 *   les catégories en sensible à la casse ; deux chaînes différentes ne
 *   doivent pas partager une entrée.
 */
export function buildCatalogCacheKey(params: {
  limit: number;
  category?: string | null;
  search?: string | null;
}): string {
  const limit =
    Number.isFinite(params.limit) && params.limit > 0 ? Math.floor(params.limit) : 1000;
  const category = params.category?.trim() || "all";
  const search = params.search?.trim().toLowerCase() ?? "";
  return `catalog:${CATALOG_CACHE_VERSION}:${limit}:${category}:${search ? hashRecherche(search) : "none"}`;
}

/**
 * Tronque une description pour le payload client : trim, plafond à
 * `maxChars` caractères avec suffixe « … » (le suffixe compte dans le
 * plafond), tolérant aux entrées non textuelles (null, nombres…).
 */
export function truncateDescription(value: unknown, maxChars: number = CATALOG_DESCRIPTION_MAX_CHARS): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const ceiling = Math.max(1, Math.floor(maxChars));
  if (trimmed.length <= ceiling) return trimmed;
  return `${trimmed.slice(0, ceiling - 1).trimEnd()}…`;
}

/**
 * ETag fort : SHA-256 du corps exact, guillemets doubles inclus (RFC 7232).
 * Le corps étant déterministe (clé de cache identique → corps identique),
 * l'ETag est stable entre les instances et les redéploiements.
 */
export function strongEtag(body: string): string {
  return `"${createHash("sha256").update(body, "utf8").digest("hex")}"`;
}

/**
 * Évalue If-None-Match contre l'ETag courant (comparaison FAIBLE conformément
 * à RFC 7232 §2.3 : `W/"x"` correspond à `"x"`). Gère `*` (tout correspond)
 * et les listes séparées par des virgules. Absent → jamais de 304.
 */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const header = ifNoneMatch.trim();
  if (!header) return false;
  if (header === "*") return true;
  return header.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === etag || tag === `W/${etag}`;
  });
}

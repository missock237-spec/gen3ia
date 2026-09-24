import { NextRequest, NextResponse } from "next/server";

import { protectRoute } from "@/lib/security/route-guard";
import {
  CONNECTION_CATEGORIES,
  CONNECTIONS_CATALOG,
  listComposioToolkits,
  type ConnectionCategory,
} from "@/lib/integrations/composio/connections";
import { cacheGet, cacheSet } from "@/lib/cache/redis";
import {
  buildCatalogCacheKey,
  CATALOG_CACHE_TTL_SECONDS,
  etagMatches,
  strongEtag,
  truncateDescription,
  type CatalogResponseEnvelope,
} from "@/lib/integrations/catalog-cache";
import { logger } from "@/lib/observability/logger";

export const runtime = "nodejs";

type CatalogItem = {
  toolkit: string;
  label: string;
  /** Description tronquée à ~140 caractères (payload maîtrisé). */
  description: string;
  logo?: string | null;
  /** Categorie normalisee pour l'UI /integrations. */
  category: ConnectionCategory | "other";
  /** Type d'authentification dominant (informatif pour l'UI). */
  auth: "oauth" | "api_key" | "no_auth";
};

const CATEGORY_SET = new Set<string>(CONNECTION_CATEGORIES);

/**
 * Taxonomie Composio -> catégories Gen3ia. Une entrée par slug Composio
 * significatif ; les slugs absents tombent dans "other". Ordre sans importance :
 * la première catégorie du toolkit qui matche gagne (ordre du tableau du toolkit).
 */
const COMPOSIO_CATEGORY_MAP: Record<string, ConnectionCategory | "other"> = {
  // Messagerie
  "team-chat": "messaging",
  "communication": "messaging",
  "phone-&-sms": "messaging",
  "notifications": "messaging",
  // Réseaux sociaux
  "social-media-accounts": "social",
  "social-media-marketing": "social",
  // Email & calendrier
  "email": "email_calendar",
  "calendar": "email_calendar",
  "transactional-email": "email_calendar",
  "email-newsletters": "email_calendar",
  "drip-emails": "email_calendar",
  "scheduling-&-booking": "email_calendar",
  // CRM
  "crm": "crm",
  "sales-&-crm": "crm",
  "contact-management": "crm",
  "customer-support": "crm",
  "support": "crm",
  // E-commerce & paiements
  "ecommerce": "ecommerce",
  "commerce": "ecommerce",
  "payment-processing": "ecommerce",
  "accounting": "ecommerce",
  "proposal-&-invoice-management": "ecommerce",
  "taxes": "ecommerce",
  // Développement
  "developer-tools": "developer",
  "developer-tools-&-devops": "developer",
  "it-operations": "developer",
  "server-monitoring": "developer",
  "security-&-identity-tools": "developer",
  "website-builders": "developer",
  "website-&-app-building": "developer",
  "app-builder": "developer",
  "model-context-protocol": "developer",
  // Base de connaissances
  "notes": "knowledge",
  "documents": "knowledge",
  "file-management-&-storage": "knowledge",
  "bookmark-managers": "knowledge",
  // Données
  "databases": "data",
  "spreadsheets": "data",
  "analytics": "data",
  "business-intelligence": "data",
  "dashboards": "data",
};

function normaliserAuth(item: { authSchemes?: string[]; noAuth?: boolean }): CatalogItem["auth"] {
  if (item.noAuth) return "no_auth";
  const schemes = Array.isArray(item.authSchemes) ? item.authSchemes.map((scheme) => String(scheme).toUpperCase()) : [];
  if (schemes.includes("OAUTH2") || schemes.includes("OAUTH")) return "oauth";
  if (schemes.includes("API_KEY")) return "api_key";
  if (schemes.includes("NO_AUTH")) return "no_auth";
  return "oauth";
}

function normaliserCategories(item: { categories?: string[] }): ConnectionCategory | "other" {
  const list = Array.isArray(item.categories) ? item.categories : [];
  const direct = list.find((category) => typeof category === "string" && CATEGORY_SET.has(category));
  if (direct) return direct as ConnectionCategory;
  const mapped = list.map((category) => (typeof category === "string" ? COMPOSIO_CATEGORY_MAP[category] : undefined)).find(Boolean);
  return mapped ?? "other";
}

/**
 * Normalise un toolkit brut vers la forme SLIM renvoyée au client. Seuls les
 * champs réellement consommés par le front sont conservés (audit d'usage
 * Task 25-g) : `categories` (slugs bruts Composio), `authSchemes` et
 * `managedBy` ne sont lus par AUCUN composant — ils représentaient l'essentiel
 * du payload de 380 Ko. Le champ `category` (normalisé) et `auth` restent
 * fournis : l'UI /integrations filtre et affiche avec eux.
 */
function versItemCatalogue(item: {
  toolkit: string;
  label: string;
  description: string;
  logo?: string | null;
  categories?: string[];
  authSchemes?: string[];
  noAuth?: boolean;
}): CatalogItem {
  return {
    toolkit: item.toolkit,
    label: item.label || item.toolkit,
    description: truncateDescription(item.description),
    logo: item.logo ?? null,
    category: normaliserCategories(item),
    auth: normaliserAuth(item),
  };
}

function catalogueStatique(options: { search?: string; category?: string }): CatalogItem[] {
  return filtrerCatalogue(
    CONNECTIONS_CATALOG.map((entry) => ({
      toolkit: entry.toolkit,
      label: entry.label,
      description: truncateDescription(entry.description),
      logo: null,
      category: entry.category,
      auth: entry.auth,
    })),
    options,
  );
}

function filtrerCatalogue(items: CatalogItem[], options: { search?: string; category?: string }): CatalogItem[] {
  const search = options.search?.trim().toLowerCase();
  if (!options.category && !search) return items;
  return items.filter((item) => {
    if (options.category && item.category !== options.category) return false;
    if (!search) return true;
    return (
      item.label.toLowerCase().includes(search) ||
      item.toolkit.toLowerCase().includes(search) ||
      item.description.toLowerCase().includes(search)
    );
  });
}

/**
 * Stratégie de cache (Task 25-g) — trois étages, en dégradation silencieuse :
 *
 *  1. ENVELOPPES PAR REQUÊTE (mémoire + Redis, TTL 5 min) — la réponse JSON
 *     SÉRIALIZÉE + son ETag fort, par variante (limit/catégorie/recherche).
 *     Sur hit : zéro filtrage, zéro re-sérialisation, corps servi tel quel.
 *     Clé versionnée `g3:catalog:v3:<limit>:<category>:<q-hash>` (bump de
 *     CATALOG_CACHE_VERSION = invalidation instantanée de toutes les clés).
 *  2. LISTE COMPLÈTE DES ITEMS (mémoire + Redis, TTL 10 min) — matière
 *     première partagée par toutes les variantes : une nouvelle recherche
 *     part du cache et non d'une nouvelle agrégation Composio.
 *  3. COMPOSIO (1 à 5 pages paginées) — uniquement sur froid, en
 *     single-flight (les requêtes concurrentes partagent la même promesse)
 *     et sous budget temporel (au-delà, réponse dégradée sans empoisonner
 *     le cache ; l'agrégation continue en arrière-plan et alimentera les
 *     étages 1 et 2 pour les requêtes suivantes).
 *
 * Redis est une accélération, jamais une dépendance : cacheGet/cacheSet
 * retournent null/false en cas d'absence ou d'erreur → la route continue
 * (aucune 500 liée au cache).
 */

// ─ Étage 2 : liste complète (matière première) ──────────────────────────────
const RAW_LIST_KEY = "integrations:catalog:v3";
const RAW_LIST_TTL_SECONDS = 10 * 60;
const RAW_LIST_TTL_MS = RAW_LIST_TTL_SECONDS * 1000;

/**
 * Budget global de l'agrégation Composio (1 à 5 appels paginés) : au-delà,
 * on renonce pour cette requête et on sert le catalogue intégré — la page
 * /integrations doit répondre en quelques secondes même si Composio est
 * lent ou en panne. Les tentatives suivantes repartiront du cache vide.
 */
const AGGREGATION_BUDGET_MS = 25_000;

let rawItems: CatalogItem[] | null = null;
let rawExpiresAt = 0;
let rawPromise: Promise<CatalogItem[]> | null = null;

function agregerCatalogueComposio(): Promise<CatalogItem[]> {
  return listComposioToolkits({ limit: 1000 }).then((dynamic) => dynamic.items.map(versItemCatalogue));
}

/** Agrégation partagée (single-flight) : un seul appel Composio à la fois. */
function demarrerAggregationPartagee(): Promise<CatalogItem[]> {
  if (!rawPromise) {
    rawPromise = agregerCatalogueComposio()
      .then((items) => {
        if (items.length > 0) {
          rawItems = items;
          rawExpiresAt = Date.now() + RAW_LIST_TTL_MS;
          // Opportuniste : alimente l'étage Redis pour les autres instances
          // (échec silencieux si Redis indisponible).
          void cacheSet(RAW_LIST_KEY, items, RAW_LIST_TTL_SECONDS);
          logger.info({ route: "/api/integrations/catalog", items: items.length }, "integrations.catalog.aggregated");
        }
        return items;
      })
      .finally(() => {
        rawPromise = null;
      });
  }
  return rawPromise;
}

async function chargerCatalogueComplet(): Promise<CatalogItem[]> {
  if (rawItems && Date.now() < rawExpiresAt) return rawItems;

  // Cache distribué Redis : sert immédiatement si une autre instance a
  // déjà agrégé Composio récemment (null si absent/indisponible).
  const stocke = await cacheGet<CatalogItem[]>(RAW_LIST_KEY);
  if (Array.isArray(stocke) && stocke.length > 0) {
    rawItems = stocke;
    rawExpiresAt = Date.now() + RAW_LIST_TTL_MS;
    return rawItems;
  }

  // Froid : single-flight + budget. Si le budget expire, la promesse
  // partagée continue en arrière-plan et remplira les caches.
  const partagee = demarrerAggregationPartagee();
  // Évite un rejet non géré si le budget gagne la course et que Composio
  // échoue ensuite (le catch de la route courante ne couvre pas ce cas).
  partagee.catch(() => {});
  const budget = new Promise<CatalogItem[]>((resolve) => setTimeout(() => resolve([]), AGGREGATION_BUDGET_MS));
  return Promise.race([partagee, budget]);
}

// ─ Étage 1 : enveloppes prêtes à servir (mémoire bornée + Redis) ────────────
const ENVELOPE_TTL_MS = CATALOG_CACHE_TTL_SECONDS * 1000;
/** Borne mémoire : les recherches sont arbitraires (cardinalité non bornée). */
const MEMORY_ENVELOPE_MAX_ENTRIES = 48;
const enveloppesMemoire = new Map<string, { envelope: CatalogResponseEnvelope; expiresAt: number }>();

function lireEnveloppeMemoire(key: string): CatalogResponseEnvelope | null {
  const entry = enveloppesMemoire.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    enveloppesMemoire.delete(key);
    return null;
  }
  return entry.envelope;
}

function stockerEnveloppeMemoire(key: string, envelope: CatalogResponseEnvelope): void {
  // Éviction FIFO simple : supprime puis réinsère pour rafraîchir la
  // position (Map itère dans l'ordre d'insertion).
  if (enveloppesMemoire.size >= MEMORY_ENVELOPE_MAX_ENTRIES && !enveloppesMemoire.has(key)) {
    const oldest = enveloppesMemoire.keys().next().value;
    if (oldest !== undefined) enveloppesMemoire.delete(oldest);
  }
  enveloppesMemoire.set(key, { envelope, expiresAt: Date.now() + ENVELOPE_TTL_MS });
}

/**
 * Résultat de construction d'une variante : l'enveloppe prête à servir et
 * l'indice de mise en cache. Une enveloppe DÉGRADÉE (repli statique) n'est
 * jamais écrite en cache : elle est quasi gratuite à reconstruire (19 items
 * statiques) et ne doit pas empoisonner la clé pour les 5 prochaines
 * minutes une fois Composio rétabli.
 */
interface VarianteConstruite {
  envelope: CatalogResponseEnvelope;
  cacheable: boolean;
}

/**
 * Cache-aside d'enveloppe : mémoire → Redis → construction. L'enveloppe
 * stockée est validée (etag/body chaînes) pour ignorer proprement toute
 * entrée illisible ou d'un schéma antérieur.
 */
async function chargerEnveloppe(
  key: string,
  construire: () => Promise<VarianteConstruite>,
): Promise<{ envelope: CatalogResponseEnvelope; cache: "memory" | "redis" | "miss" }> {
  const memoire = lireEnveloppeMemoire(key);
  if (memoire) return { envelope: memoire, cache: "memory" };

  const stockee = await cacheGet<CatalogResponseEnvelope>(key);
  if (
    stockee &&
    typeof stockee === "object" &&
    typeof stockee.etag === "string" &&
    typeof stockee.body === "string" &&
    stockee.body.length > 0
  ) {
    stockerEnveloppeMemoire(key, stockee);
    return { envelope: stockee, cache: "redis" };
  }

  const construite = await construire();
  if (construite.cacheable) {
    stockerEnveloppeMemoire(key, construite.envelope);
    // Await (et non fire-and-forget) : dans un runtime serverless, une
    // promesse non attendue peut être gelée après la réponse — on veut la
    // garantie que l'entrée est bien posée pour les requêtes suivantes.
    await cacheSet(key, construite.envelope, CATALOG_CACHE_TTL_SECONDS);
  }
  return { envelope: construite.envelope, cache: "miss" };
}

/**
 * Choix de Cache-Control (documenté, Task 25-g) : le corps est identique
 * pour tous les utilisateurs (catalogue global, aucune donnée personnelle),
 * MAIS la route est derrière une authentification (401 sans session) et est
 * servie avec les credentials du client. `private` interdit la mise en cache
 * par des intermédiaires partagés (CDN/proxy d'entreprise) sur une réponse
 * authentifiée — prudence entreprise ; seul le navigateur du client cache
 * 60 s puis revalide (ETag → 304) pendant 5 min de stale-while-revalidate.
 */
const CATALOG_CACHE_CONTROL = "private, max-age=60, stale-while-revalidate=300";

/**
 * Construit la réponse 200 ou 304 selon If-None-Match. L'ETag est TOUJOURS
 * calculé sur le corps effectivement servi (ETag fort : même octet ⇒ même
 * hash), y compris sur le chemin dégradé reconstruit à chaque requête.
 */
function repondreCatalogue(request: NextRequest, envelope: CatalogResponseEnvelope, cacheStatut: string): NextResponse {
  if (etagMatches(request.headers.get("if-none-match"), envelope.etag)) {
    // 304 : zéro octet de payload, entêtes de cache conservés (RFC 9110 §15.4.5).
    return new NextResponse(null, {
      status: 304,
      headers: {
        etag: envelope.etag,
        "cache-control": CATALOG_CACHE_CONTROL,
        "x-gen3ia-catalog-cache": cacheStatut,
      },
    });
  }
  return new NextResponse(envelope.body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      etag: envelope.etag,
      "cache-control": CATALOG_CACHE_CONTROL,
      "x-gen3ia-catalog-cache": cacheStatut,
    },
  });
}

/** Sérialise une fois, hash une fois : { etag, body } prêt à mettre en cache. */
function enveloppe(
  items: CatalogItem[],
  meta: { source: "composio" | "catalogue-integre"; degradedReason: string | null; totalAvantLimite: number },
): CatalogResponseEnvelope {
  const body = JSON.stringify({
    items,
    nextCursor: null,
    totalItems: meta.totalAvantLimite,
    categories: CONNECTION_CATEGORIES,
    provider: "composio",
    source: meta.source,
    ...(meta.degradedReason ? { degraded: true, degradedReason: meta.degradedReason } : {}),
  });
  return { etag: strongEtag(body), body };
}

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() || undefined;
  const category = url.searchParams.get("category")?.trim() || undefined;
  // Limit borné et défendu contre les valeurs non numériques (NaN historique
  // tronquait la réponse à zéro item via slice(0, NaN)).
  const limitDemande = Number(url.searchParams.get("limit") || "1000");
  const limit = Number.isFinite(limitDemande) ? Math.min(5000, Math.max(1, Math.floor(limitDemande))) : 1000;

  const key = buildCatalogCacheKey({ limit, category, search });

  const { envelope, cache } = await chargerEnveloppe(key, async (): Promise<VarianteConstruite> => {
    let degradedReason: string | null = null;

    // 1) Catalogue dynamique Composio complet (1559 services), servi depuis
    //    les caches mémoire/Redis et filtré en mémoire.
    try {
      const full = await chargerCatalogueComplet();
      if (full.length > 0) {
        const filtered = filtrerCatalogue(full, { search, category });
        // totalItems = nombre de correspondances AVANT limite (contrat
        // historique préservé), la page renvoyée étant bornée à `limit`.
        return {
          cacheable: true,
          envelope: enveloppe(filtered.slice(0, limit), {
            source: "composio",
            degradedReason: null,
            totalAvantLimite: filtered.length,
          }),
        };
      }
      degradedReason = "catalogue Composio momentanément indisponible";
    } catch (error) {
      // Composio indisponible ou clé absente : on retombe sur le catalogue
      // intégré — MAIS on trace la cause et on l'annonce à l'UI (bannière
      // mode dégradé) au lieu d'un silentieux "19 apps" sans explication.
      degradedReason = error instanceof Error ? error.message : "Composio indisponible";
      logger.warn({ err: error, route: "/api/integrations/catalog" }, "integrations.catalog.degraded");
    }

    // 2) Repli : catalogue intégré — la page ne doit JAMAIS rester vide, sinon
    //    l'utilisateur ne peut pas démarrer une connexion OAuth.
    const statiques = catalogueStatique({ search, category });
    return {
      cacheable: false,
      envelope: enveloppe(statiques, {
        source: "catalogue-integre",
        degradedReason,
        totalAvantLimite: statiques.length,
      }),
    };
  });

  return repondreCatalogue(request, envelope, cache === "miss" ? "MISS" : cache === "redis" ? "REDIS-HIT" : "MEMORY-HIT");
}

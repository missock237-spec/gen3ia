import { NextRequest, NextResponse } from "next/server";

import { protectRoute } from "@/lib/security/route-guard";
import {
  CONNECTION_CATEGORIES,
  CONNECTIONS_CATALOG,
  listComposioToolkits,
  type ConnectionCategory,
} from "@/lib/integrations/composio/connections";
import { logger } from "@/lib/observability/logger";

export const runtime = "nodejs";

type CatalogItem = {
  toolkit: string;
  label: string;
  description: string;
  logo?: string | null;
  categories?: string[];
  authSchemes?: string[];
  managedBy?: string;
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

function versItemCatalogue(item: {
  toolkit: string;
  label: string;
  description: string;
  logo?: string | null;
  categories?: string[];
  authSchemes?: string[];
  managedBy?: string;
  noAuth?: boolean;
}): CatalogItem {
  return {
    toolkit: item.toolkit,
    label: item.label || item.toolkit,
    description: item.description ?? "",
    logo: item.logo ?? null,
    categories: Array.isArray(item.categories) ? item.categories : [],
    authSchemes: Array.isArray(item.authSchemes) ? item.authSchemes : [],
    managedBy: item.managedBy ?? "composio",
    category: normaliserCategories(item),
    auth: normaliserAuth(item),
  };
}

function catalogueStatique(options: { search?: string; category?: string }): CatalogItem[] {
  return filtrerCatalogue(
    CONNECTIONS_CATALOG.map((entry) => ({
      ...entry,
      logo: null,
      categories: [entry.category],
      authSchemes: entry.auth === "oauth" ? ["OAUTH2"] : entry.auth === "api_key" ? ["API_KEY"] : ["NO_AUTH"],
      managedBy: "gen3ia",
      noAuth: entry.auth === "no_auth",
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
 * Cache mémoire du catalogue complet (processus serveur).
 *
 * L'agrégation paginée coute plusieurs appels Composio (1 à 5 selon le total) :
 * on met en cache la liste NORMALISÉE complète 10 minutes pour que chaque
 * requête (recherche, filtre, rechargement) réponde instantanément. Les
 * requêtes concurrentes partagent la même promesse de chargement.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
let cachedItems: CatalogItem[] | null = null;
let cacheExpiresAt = 0;
let cachePromise: Promise<CatalogItem[]> | null = null;

/**
 * Budget global de l'agrégation Composio (1 à 5 appels paginés) : au-delà,
 * on renonce pour cette requête et on sert le catalogue intégré — la page
 * /integrations doit répondre en quelques secondes même si Composio est
 * lent ou en panne. Les tentatives suivantes repartiront du cache vide.
 */
const AGGREGATION_BUDGET_MS = 25_000;

async function chargerCatalogueComplet(): Promise<CatalogItem[]> {
  if (cachedItems && Date.now() < cacheExpiresAt) return cachedItems;
  if (!cachePromise) {
    const aggregation = listComposioToolkits({ limit: 1000 })
      .then((dynamic) => dynamic.items.map(versItemCatalogue))
      .then((items) => {
        if (items.length > 0) {
          cachedItems = items;
          cacheExpiresAt = Date.now() + CACHE_TTL_MS;
        }
        return items;
      })
      .finally(() => {
        cachePromise = null;
      });
    cachePromise = aggregation;
  }
  const budget = new Promise<CatalogItem[]>((resolve) =>
    setTimeout(() => resolve([]), AGGREGATION_BUDGET_MS),
  );
  return Promise.race([cachePromise, budget]);
}

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() || undefined;
  const category = url.searchParams.get("category")?.trim() || undefined;
  const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") || "1000")));

  let items: CatalogItem[] = [];
  let source: "composio" | "catalogue-integre" = "catalogue-integre";
  let degradedReason: string | null = null;

  // 1) Catalogue dynamique Composio complet (plus de 800 services), servi
  //    depuis le cache mémoire et filtré en mémoire — réponse instantanée.
  try {
    const full = await chargerCatalogueComplet();
    if (full.length > 0) {
      source = "composio";
      items = filtrerCatalogue(full, { search, category });
    } else {
      degradedReason = "catalogue Composio momentanément indisponible";
    }
  } catch (error) {
    // Composio indisponible ou clé absente : on retombe sur le catalogue
    // intégré — MAIS on trace la cause et on l'annonce à l'UI (bannière
    // mode dégradé) au lieu d'un silentieux "19 apps" sans explication.
    degradedReason = error instanceof Error ? error.message : "Composio indisponible";
    logger.warn({ err: error, route: "/api/integrations/catalog" }, "integrations.catalog.degraded");
  }

  // 2) Repli : catalogue intégré — la page ne doit JAMAIS rester vide, sinon
  //    l'utilisateur ne peut pas démarrer une connexion OAuth.
  if (items.length === 0) {
    items = catalogueStatique({ search, category });
    source = "catalogue-integre";
  }

  const returned = items.slice(0, limit);
  return NextResponse.json(
    {
      items: returned,
      nextCursor: null,
      totalItems: items.length,
      categories: CONNECTION_CATEGORIES,
      provider: "composio",
      source,
      ...(degradedReason ? { degraded: true, degradedReason } : {}),
    },
    { headers: { "cache-control": "private, max-age=60, stale-while-revalidate=300" } },
  );
}

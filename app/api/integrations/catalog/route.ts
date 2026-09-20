import { NextRequest, NextResponse } from "next/server";

import { protectRoute } from "@/lib/security/route-guard";
import {
  CONNECTION_CATEGORIES,
  CONNECTIONS_CATALOG,
  listComposioToolkits,
  type ConnectionCategory,
} from "@/lib/integrations/composio/connections";

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
  const matched = list.find((category) => typeof category === "string" && CATEGORY_SET.has(category));
  return (matched as ConnectionCategory | undefined) ?? "other";
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
  const search = options.search?.toLowerCase();
  return CONNECTIONS_CATALOG.filter((entry) => {
    if (options.category && entry.category !== options.category) return false;
    if (!search) return true;
    return (
      entry.label.toLowerCase().includes(search) ||
      entry.toolkit.toLowerCase().includes(search) ||
      entry.description.toLowerCase().includes(search)
    );
  }).map((entry) => ({
    ...entry,
    logo: null,
    categories: [entry.category],
    authSchemes: entry.auth === "oauth" ? ["OAUTH2"] : entry.auth === "api_key" ? ["API_KEY"] : ["NO_AUTH"],
    managedBy: "gen3ia",
    noAuth: entry.auth === "no_auth",
  }));
}

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() || undefined;
  const category = url.searchParams.get("category")?.trim() || undefined;
  const cursor = url.searchParams.get("cursor")?.trim() || undefined;
  const limit = Number(url.searchParams.get("limit") || "50");

  let items: CatalogItem[] = [];
  let nextCursor: string | null = null;
  let source: "composio" | "catalogue-integre" = "catalogue-integre";

  // 1) Catalogue dynamique Composio (des centaines de services, recherche incluse).
  try {
    const dynamic = await listComposioToolkits({ search, category, cursor, limit });
    items = dynamic.items.map(versItemCatalogue);
    nextCursor = dynamic.nextCursor;
    if (items.length > 0) source = "composio";
  } catch {
    // Composio indisponible ou cle absente : on retombe sur le catalogue integre.
    items = [];
  }

  // 2) Repli : catalogue integre — la page ne doit JAMAIS rester vide, sinon
  //    l'utilisateur ne peut pas demarrer une connexion OAuth.
  if (items.length === 0) {
    items = catalogueStatique({ search, category });
    nextCursor = null;
  }

  return NextResponse.json(
    { items, nextCursor, totalItems: items.length, categories: CONNECTION_CATEGORIES, provider: "composio", source },
    { headers: { "cache-control": "private, max-age=60, stale-while-revalidate=300" } },
  );
}

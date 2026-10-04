import { NextResponse } from "next/server";

import { authenticateDeveloper } from "@/lib/extensions/developer-keys";
import { extensionApiError } from "@/lib/extensions/api";
import { validateManifest } from "@/lib/extensions/manifest";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { cacheWrap } from "@/lib/cache/redis";
import { createExtension, getExtension, listApprovedCatalogPage } from "@/lib/extensions/repository";

/**
 * Hash court non cryptographique (FNV-1a, base36) — Task 96-d : borne la
 * longueur des clés de cache pour les paramètres libres (q, cursor) tout en
 * gardant une discriminabilité largement suffisante pour un catalogue.
 */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export async function POST(request: Request) {
  try {
    const developer = await authenticateDeveloper(request);
    const body = await request.json().catch(() => null);
    const requestedProjectId = typeof (body as { projectId?: unknown } | null)?.projectId === "string" ? String((body as { projectId: string }).projectId).trim() : "";
    const projectId = developer.projectId ?? requestedProjectId;
    if (!projectId) return NextResponse.json({ error: "Sélectionnez un projet Gen3ia avant de créer une extension." }, { status: 400 });
    if (!developer.projectId) {
      const { verifyDeveloperProjectAccess } = await import("@/lib/extensions/repository");
      await verifyDeveloperProjectAccess(developer.userId, projectId);
    }
    const result = validateManifest((body as { manifest?: unknown } | null)?.manifest ?? body);
    if (!result.ok) return NextResponse.json({ error: "Manifest invalide.", details: result.errors }, { status: 400 });
    const existing = await getExtension(result.manifest.id);
    if (existing) return NextResponse.json({ error: `L'identifiant "${result.manifest.id}" est déjà utilisé.` }, { status: 400 });
    const manifest = { ...result.manifest, author: developer.userId };
    const extension = await createExtension({ userId: developer.userId, displayName: developer.displayName, projectId }, manifest);
    return NextResponse.json({ extension, warnings: result.warnings }, { status: 201 });
  } catch (error) { return extensionApiError(error); }
}

/** Marketplace catalog is account-only: public users cannot enumerate extensions through the API. */
export async function GET(request: Request) {
  try {
    // L'authentification reste TOUJOURS avant le cache : aucune réponse
    // catalogue n'est servie sans session vérifiée.
    await verifyFirebaseAuth(request);
    const url = new URL(request.url);
    const sortParam = url.searchParams.get("sort") ?? "popular";
    const sort = (["popular", "newest", "price_asc", "rating"] as const).includes(sortParam as never)
      ? (sortParam as "popular" | "newest" | "price_asc" | "rating")
      : "popular";
    // Normalisation canonique (Task 96-d) : valeurs identiques pour le loader
    // et la clé de cache. limit reflète le clamp du repository ([1,100]) —
    // une valeur invalide retombe sur le défaut 48 (au lieu d'une page vide) ;
    // q/category sont trimmés, exactement ce que le loader consomme.
    const q = (url.searchParams.get("q") ?? "").trim() || undefined;
    const category = (url.searchParams.get("category") ?? "").trim() || undefined;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 48) || 48, 1), 100);
    const cursor = (url.searchParams.get("cursor") ?? "").trim() || undefined;

    // Task 96-d : cache-aside Redis sur le catalogue approuvé. Le payload est
    // IDENTIQUE pour tous les utilisateurs authentifiés (favoris, installations
    // et achats passent par des routes séparées) alors que la lecture Firestore
    // coûte jusqu'à 200 documents + un tri mémoire À CHAQUE requête. Clé sans
    // donnée personnelle : sort / catégorie / hachages courts de q et cursor /
    // limit. TTL 90 s (fenêtre 60-120 s) : un retard de publication de
    // catalogue d'une minute et demie est acceptable. Dégradation gracieuse
    // assurée par cacheWrap : sans Redis, le loader s'exécute à chaque fois.
    const { value: payload } = await cacheWrap(
      `ext:cat:${sort}:${encodeURIComponent(category ?? "-")}:${shortHash(q ?? "")}:${shortHash(cursor ?? "")}:${limit}`,
      90,
      async () => {
        const page = await listApprovedCatalogPage({ q, category, limit, sort, cursor });
        return {
          sort: page.sort,
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          extensions: page.docs.map((extension) => ({
            id: extension.id, name: extension.name, description: extension.description, category: extension.category,
            tags: extension.tags, developerName: extension.developerName, latestVersion: extension.latestVersion,
            approvedVersion: extension.approvedVersion, pricing: extension.pricing,
            stats: { installs: extension.stats.installs, ratingCount: extension.stats.ratingCount, rating: extension.stats.ratingCount > 0 ? Number((extension.stats.ratingSum / extension.stats.ratingCount).toFixed(2)) : null },
          })),
        };
      },
    );
    return NextResponse.json(payload);
  } catch (error) { return extensionApiError(error); }
}

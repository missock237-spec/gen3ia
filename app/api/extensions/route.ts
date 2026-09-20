import { NextResponse } from "next/server";

import { authenticateDeveloper } from "@/lib/extensions/developer-keys";
import { extensionApiError } from "@/lib/extensions/api";
import { validateManifest } from "@/lib/extensions/manifest";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { createExtension, getExtension, listApprovedExtensions } from "@/lib/extensions/repository";

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
    await verifyFirebaseAuth(request);
    const url = new URL(request.url);
    const extensions = await listApprovedExtensions({
      q: url.searchParams.get("q") ?? undefined,
      category: url.searchParams.get("category") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 48),
    });
    return NextResponse.json({ extensions: extensions.map((extension) => ({
      id: extension.id, name: extension.name, description: extension.description, category: extension.category,
      tags: extension.tags, developerName: extension.developerName, latestVersion: extension.latestVersion,
      approvedVersion: extension.approvedVersion, pricing: extension.pricing,
      stats: { installs: extension.stats.installs, ratingCount: extension.stats.ratingCount, rating: extension.stats.ratingCount > 0 ? Number((extension.stats.ratingSum / extension.stats.ratingCount).toFixed(2)) : null },
    })) });
  } catch (error) { return extensionApiError(error); }
}

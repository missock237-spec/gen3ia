import { NextResponse } from "next/server";

import { authenticateDeveloper } from "@/lib/extensions/developer-keys";
import { extensionApiError } from "@/lib/extensions/api";
import { listExtensionsByDeveloper } from "@/lib/extensions/repository";

/**
 * GET /api/developer/extensions — Developer Studio list:
 * own extensions with status, versions and aggregate stats.
 */
export async function GET(request: Request) {
  try {
    const developer = await authenticateDeveloper(request);
    const url = new URL(request.url);
    const requestedProjectId = url.searchParams.get("projectId")?.trim() ?? "";
    const projectId = developer.projectId ?? requestedProjectId;
    if (!projectId) throw new Error("Sélectionnez un projet Gen3ia.");
    if (!developer.projectId) {
      const { verifyDeveloperProjectAccess } = await import("@/lib/extensions/repository");
      await verifyDeveloperProjectAccess(developer.userId, projectId);
    }
    const extensions = await listExtensionsByDeveloper(developer.userId, projectId);
    return NextResponse.json({
      developer: { userId: developer.userId, displayName: developer.displayName, projectId },
      extensions: extensions.map((extension) => ({
        id: extension.id,
        name: extension.name,
        description: extension.description,
        category: extension.category,
        status: extension.status,
        latestVersion: extension.latestVersion,
        approvedVersion: extension.approvedVersion,
        permissions: extension.permissions,
        pricing: extension.pricing,
        stats: extension.stats,
        rating:
          extension.stats.ratingCount > 0
            ? Number((extension.stats.ratingSum / extension.stats.ratingCount).toFixed(2))
            : null,
        updatedAt: extension.updatedAt,
      })),
    });
  } catch (error) {
    return extensionApiError(error);
  }
}

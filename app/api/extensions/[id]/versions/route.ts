import { NextResponse } from "next/server";

import { authenticateDeveloper } from "@/lib/extensions/developer-keys";
import { extensionApiError } from "@/lib/extensions/api";
import { validateManifest } from "@/lib/extensions/manifest";
import { createVersion, getExtension, getVersion, listVersions } from "@/lib/extensions/repository";

type Params = { params: Promise<{ id: string }> };

/** GET /api/extensions/:id/versions — version history (developer or public metadata). */
export async function GET(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    let versions;
    try {
      const developer = await authenticateDeveloper(request);
      if (!developer.projectId) throw new Error("Developer project is required.");
      versions = await listVersions(id, developer.userId, developer.projectId);
    } catch {
      const extension = await getExtension(id);
      if (!extension || extension.status !== "approved") {
        return NextResponse.json({ error: "Historique non disponible." }, { status: 404 });
      }
      versions = (await listVersions(id)).filter((version) => version.status === "approved");
    }
    return NextResponse.json({
      versions: versions.map((version) => ({
        version: version.version,
        changelog: version.changelog,
        status: version.status,
        submittedAt: version.submittedAt ?? null,
        reviewedAt: version.reviewedAt ?? null,
        ...(version.status === "approved" ? {} : { reviewNote: version.reviewNote ?? null }),
        createdAt: version.createdAt,
      })),
    });
  } catch (error) {
    return extensionApiError(error);
  }
}

/**
 * POST /api/extensions/:id/versions — upload a new version (developer only).
 * Body: { manifest, changelog? } — the manifest id must match :id and the
 * version must be strictly new. Status starts as "draft".
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const developer = await authenticateDeveloper(request);
    const { id } = await params;
    const extension = await getExtension(id);
    if (!extension) return NextResponse.json({ error: "Extension introuvable." }, { status: 404 });
    if (extension.developerId !== developer.userId) {
      return NextResponse.json({ error: "Seul le développeur peut ajouter une version." }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const requestedProjectId = typeof (body as { projectId?: unknown } | null)?.projectId === "string" ? String((body as { projectId: string }).projectId).trim() : "";
    const projectId = developer.projectId ?? requestedProjectId;
    if (!projectId || extension.projectId !== projectId) return NextResponse.json({ error: "Cette extension n'appartient pas au projet Gen3ia lié." }, { status: 403 });
    const result = validateManifest((body as { manifest?: unknown } | null)?.manifest ?? body);
    if (!result.ok) {
      return NextResponse.json({ error: "Manifest invalide.", details: result.errors }, { status: 400 });
    }
    if (result.manifest.id !== id) {
      return NextResponse.json({ error: "L'id du manifest doit correspondre à l'extension." }, { status: 400 });
    }
    const existing = await getVersion(id, result.manifest.version);
    if (existing) {
      return NextResponse.json({ error: `La version ${result.manifest.version} existe déjà.` }, { status: 400 });
    }
    const changelog =
      typeof (body as { changelog?: unknown } | null)?.changelog === "string"
        ? (body as { changelog: string }).changelog
        : "Nouvelle version.";
    const version = await createVersion(developer.userId, projectId, { ...result.manifest, author: developer.userId }, changelog);
    return NextResponse.json({ version: { version: version.version, status: version.status }, warnings: result.warnings }, { status: 201 });
  } catch (error) {
    return extensionApiError(error);
  }
}

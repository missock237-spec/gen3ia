import { NextResponse } from "next/server";

import { authenticateDeveloper } from "@/lib/extensions/developer-keys";
import { extensionApiError } from "@/lib/extensions/api";
import { getExtension, getVersion, submitVersion } from "@/lib/extensions/repository";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/extensions/:id/submit — submit a version for marketplace review.
 * Body: { version }
 * The automated security gate already ran at manifest validation time
 * (permissions, hosts, templates, cross-references). Status -> "pending".
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const developer = await authenticateDeveloper(request);
    const { id } = await params;
    const extension = await getExtension(id);
    if (!extension) return NextResponse.json({ error: "Extension introuvable." }, { status: 404 });
    if (extension.developerId !== developer.userId) {
      return NextResponse.json({ error: "Seul le développeur peut soumettre cette extension." }, { status: 403 });
    }
    const body = (await request.json().catch(() => ({}))) as { version?: unknown; projectId?: unknown };
    const projectId = developer.projectId ?? (typeof body.projectId === "string" ? body.projectId.trim() : "");
    if (!projectId || extension.projectId !== projectId) return NextResponse.json({ error: "Cette extension n'appartient pas au projet Gen3ia lié." }, { status: 403 });
    const version = typeof body.version === "string" ? body.version : extension.latestVersion;
    if (!version) return NextResponse.json({ error: "Aucune version à soumettre." }, { status: 400 });
    const existing = await getVersion(id, version);
    if (!existing) return NextResponse.json({ error: "Version introuvable." }, { status: 404 });
    if (existing.status === "approved") {
      return NextResponse.json({ error: "Cette version est déjà approuvée." }, { status: 400 });
    }
    const submitted = await submitVersion(developer.userId, id, version, projectId);
    return NextResponse.json({
      version: { version: submitted.version, status: submitted.status, submittedAt: submitted.submittedAt },
    });
  } catch (error) {
    return extensionApiError(error);
  }
}

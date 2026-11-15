import { NextResponse, NextRequest } from "next/server";

import { getArtifactRecord } from "@/lib/documents/artifact-repository";
import { assertArtifactOwner } from "@/lib/documents/artifact-access";
import { protectRoute } from "@/lib/security/route-guard";

export const runtime = "nodejs";

/**
 * Service du contenu d'un livrable stocké EN BASE (repli sans R2).
 * L'utilisateur propriétaire télécharge le fichier réel (pptx, pdf, docx…)
 * via le cookie de session ; tout autre compte reçoit 403/404.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const { id } = await context.params;
    const artifact = await getArtifactRecord(id);
    if (!artifact) {
      return NextResponse.json({ success: false, error: "Artifact not found" }, { status: 404 });
    }
    assertArtifactOwner(artifact, guard.context.userId);
    if (artifact.expiresAt && artifact.expiresAt <= Date.now()) {
      return NextResponse.json({ success: false, error: "Artifact expired" }, { status: 410 });
    }
    if (!artifact.inlineData) {
      return NextResponse.json({ success: false, error: "Artifact not stored inline" }, { status: 404 });
    }

    const data = Buffer.from(artifact.inlineData, "base64");
    const safeName = (artifact.name || "livrable").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150);
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        "content-type": artifact.mimeType,
        "content-length": String(data.length),
        "content-disposition": `attachment; filename="${safeName}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Artifact not found";
    const status = message.toLowerCase().includes("not found") ? 404 : 403;
    return NextResponse.json({ success: false, error: status === 404 ? "Artifact not found" : "Access denied" }, { status });
  }
}

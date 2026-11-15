import { NextRequest, NextResponse } from "next/server";
import { getArtifactDownloadUrl, removeArtifact } from "@/lib/documents/artifact-store";
import { protectRoute } from "@/lib/security/route-guard";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const { id } = await context.params;
    const url = await getArtifactDownloadUrl(id, guard.context.userId);
    // Liens cliquables dans le chat (audit multimodal) : ?redirect=1 →
    // redirection 302 directe vers l'URL signée au lieu du JSON — le
    // navigateur télécharge le fichier sans passer par le panneau.
    if (request.nextUrl.searchParams.get("redirect")) {
      return NextResponse.redirect(url, 302);
    }
    return NextResponse.json({ success: true, url, expiresIn: 300 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Artifact not found";
    const status = message.toLowerCase().includes("not found") ? 404 : 403;
    return NextResponse.json({ success: false, error: status === 404 ? "Artifact not found" : "Access denied" }, { status });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const { id } = await context.params;
    await removeArtifact(id, guard.context.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Artifact not found";
    const status = message.toLowerCase().includes("not found") ? 404 : 403;
    return NextResponse.json({ success: false, error: status === 404 ? "Artifact not found" : "Access denied" }, { status });
  }
}

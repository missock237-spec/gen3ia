import { NextRequest, NextResponse } from "next/server";

import { requireCodeAgentOwner } from "@/lib/agents/code-agent-guard";
import { getArtifact } from "@/lib/domain/artifacts/repository";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";

/**
 * Contenu complet d'un fichier de l'IDE (artefact propriétaire) :
 * contenu de la version courante + historique des versions (rappel d'une
 * version précédente possible depuis l'éditeur).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ artifactId: string }> }) {
  try {
    const guard = await requireCodeAgentOwner(request);
    if ("forbidden" in guard) return guard.forbidden;

    const limit = await enforceRateLimit(`ide-file-read:${guard.user.uid}`, { limit: 240, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop de requêtes. Réessayez dans quelques instants." }, { status: 429 });
    }

    const { artifactId } = await params;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(artifactId)) {
      return NextResponse.json({ error: "Identifiant de fichier invalide." }, { status: 400 });
    }

    const artifact = await getArtifact(guard.user.uid, artifactId);
    if (!artifact) {
      return NextResponse.json({ error: "Fichier introuvable ou dont vous n'êtes pas propriétaire." }, { status: 404 });
    }

    return NextResponse.json({
      artifact: {
        artifactId: artifact.id,
        path: artifact.filename || artifact.title,
        title: artifact.title,
        language: artifact.language,
        type: artifact.type,
        content: artifact.content ?? "",
        versions: artifact.versions.map((v) => ({ version: v.version, note: v.note, createdAt: v.createdAt, chars: (v.content ?? "").length })),
      },
    });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Fichier indisponible."), { status: errorStatus(error) });
  }
}

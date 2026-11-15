import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireCodeAgentOwner } from "@/lib/agents/code-agent-guard";
import { addArtifactVersion, getArtifact, listArtifacts } from "@/lib/domain/artifacts/repository";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";

/**
 * Fichiers du Workshop IDE — explorateur et éditeur.
 *
 *  - GET  : liste des fichiers éditables (artefacts de type code/fichier de
 *           l'utilisateur, les plus récents d'abord). Le panneau gauche de
 *           l'IDE s'en nourrit (recherche, favoris, état des versions).
 *  - PUT  : sauvegarde depuis l'éditeur → NOUVELLE VERSION de l'artefact
 *           (propriété vérifiée serveur, note « édition IDE »). L'historique
 *           des versions reste intégralement réversible.
 */

const QuerySchema = z.object({
  type: z.enum(["code", "file"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const SaveSchema = z.object({
  artifactId: z.string().trim().min(1).max(128),
  content: z.string().min(1).max(500_000),
});

export async function GET(request: NextRequest) {
  try {
    const guard = await requireCodeAgentOwner(request);
    if ("forbidden" in guard) return guard.forbidden;

    const limit = await enforceRateLimit(`ide-files:${guard.user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop de requêtes. Réessayez dans quelques instants." }, { status: 429 });
    }

    const raw = Object.fromEntries(new URL(request.url).searchParams.entries());
    const filters = QuerySchema.parse(raw);
    const codeArtifacts = await listArtifacts(guard.user.uid, { type: "code", limit: filters.limit ?? 100 });
    const fileArtifacts = filters.type === "code" ? [] : await listArtifacts(guard.user.uid, { type: "file", limit: 100 });
    const artifacts = [...codeArtifacts, ...fileArtifacts].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 200);

    const files = artifacts.map((artifact) => ({
      artifactId: artifact.id,
      path: artifact.filename || `${artifact.title.replace(/[\\/:*?"<>|]/g, "_") || "fichier"}.${artifact.language ?? "txt"}`,
      title: artifact.title,
      language: artifact.language,
      type: artifact.type,
      sizeChars: (artifact.content ?? "").length,
      version: artifact.versions[0]?.version ?? 1,
      versionCount: artifact.versions.length,
      updatedAt: artifact.updatedAt,
      conversationId: artifact.conversationId,
      projectId: artifact.projectId,
    }));

    return NextResponse.json({ files });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Explorateur de fichiers indisponible."), { status: errorStatus(error) });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const guard = await requireCodeAgentOwner(request);
    if ("forbidden" in guard) return guard.forbidden;

    const limit = await enforceRateLimit(`ide-save:${guard.user.uid}`, { limit: 60, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop de sauvegardes rapprochées. Réessayez dans quelques instants." }, { status: 429 });
    }

    const parsed = SaveSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Contenu de sauvegarde invalide.", issues: parsed.error.flatten() }, { status: 400 });
    }

    const existing = await getArtifact(guard.user.uid, parsed.data.artifactId);
    if (!existing) {
      return NextResponse.json({ error: "Fichier introuvable ou dont vous n'êtes pas propriétaire." }, { status: 404 });
    }

    const updated = await addArtifactVersion(guard.user.uid, parsed.data.artifactId, {
      content: parsed.data.content,
      note: "Édition depuis le Workshop IDE",
    });

    return NextResponse.json({
      success: true,
      artifactId: updated.id,
      version: updated.versions[0]?.version ?? null,
      updatedAt: updated.updatedAt,
    });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Sauvegarde impossible."), { status: errorStatus(error) });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { adminDb } from "@/lib/firebase/admin";
import {
  deleteKnowledgeDocument,
  extractTextFromUpload,
  extractTextFromUrl,
  ingestKnowledgeDocument,
  KnowledgeDocumentRecord,
} from "@/lib/knowledge/ingestion";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Knowledge Spaces — ingestion RAG réelle.
 *
 * GET    /api/knowledge?projectId=…         : liste des documents indexés.
 * POST   /api/knowledge (multipart)         : fichiers TXT/MD/CSV/JSON/HTML/DOCX.
 * POST   /api/knowledge (JSON {url, …})     : page web (SSRF-guard) → texte.
 * DELETE /api/knowledge?id=…                : document + fragments + miroir Qdrant.
 *
 * Les documents sont scopés par utilisateur ET par projet : l'outil
 * `knowledge.search` ne retrouve que les documents du projet courant de
 * l'agent (isolation stricte, même modèle que les autres services).
 */

const URL_BODY_SCHEMA = z.object({
  url: z.string().trim().min(8).max(2000),
  projectId: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(300).optional(),
});

async function listDocuments(userId: string, projectId?: string) {
  let query = adminDb.collection("knowledgeDocuments").where("userId", "==", userId).limit(200);
  const snapshot = await query.get();
  const documents = snapshot.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() as Omit<KnowledgeDocumentRecord, "id">) }))
    .filter((document) => !projectId || document.projectId === projectId)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return documents;
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const projectId = request.nextUrl.searchParams.get("projectId")?.trim() || undefined;
    const documents = await listDocuments(user.uid, projectId);
    return NextResponse.json({ documents });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Liste des documents indisponible"), { status: errorStatus(error, 500) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`knowledge-ingest:${user.uid}:${clientIp(request)}`, { limit: 30, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop de téléversements. Réessayez dans un instant." }, { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))) } });
    }

    const contentType = request.headers.get("content-type") ?? "";

    // ── Ingestion par URL ────────────────────────────────────────────────
    if (contentType.includes("application/json")) {
      const body = URL_BODY_SCHEMA.parse(await request.json());
      const extracted = await extractTextFromUrl(body.url);
      const document = await ingestKnowledgeDocument({
        userId: user.uid,
        projectId: body.projectId,
        name: body.name || new URL(extracted.finalUrl).hostname + new URL(extracted.finalUrl).pathname.replace(/\/$/, "").slice(0, 120),
        mimeType: extracted.mimeType,
        text: extracted.text,
        source: "url",
      });
      return NextResponse.json({ document }, { status: 201 });
    }

    // ── Ingestion par fichiers (multipart) ──────────────────────────────
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const projectId = String(form.get("projectId") ?? "").trim();
      if (!projectId) return NextResponse.json({ error: "Projet manquant : sélectionnez un projet pour ce document." }, { status: 422 });

      const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
      if (files.length === 0) return NextResponse.json({ error: "Aucun fichier reçu." }, { status: 422 });
      if (files.length > 10) return NextResponse.json({ error: "10 fichiers maximum par lot." }, { status: 422 });

      const results: Array<{ name: string; status: "indexed" | "empty" | "failed"; documentId?: string; chunkCount?: number; error?: string }> = [];
      for (const file of files) {
        try {
          const extracted = await extractTextFromUpload(file);
          const document = await ingestKnowledgeDocument({
            userId: user.uid,
            projectId,
            name: file.name,
            mimeType: extracted.mimeType,
            text: extracted.text,
            source: "upload",
          });
          results.push({ name: file.name, status: document.status, documentId: document.id, chunkCount: document.chunkCount });
        } catch (error) {
          results.push({ name: file.name, status: "failed", error: error instanceof Error ? error.message : "Ingestion impossible." });
        }
      }
      const anyIndexed = results.some((result) => result.status === "indexed");
      return NextResponse.json({ results }, { status: anyIndexed ? 201 : 422 });
    }

    return NextResponse.json({ error: "Requête non supportée (multipart ou JSON attendus)." }, { status: 400 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Requête invalide : URL et projet requis." }, { status: 422 });
    }
    return NextResponse.json(errorBody(error, "Ingestion Knowledge impossible"), { status: errorStatus(error, 500) });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const id = request.nextUrl.searchParams.get("id")?.trim();
    if (!id) return NextResponse.json({ error: "Identifiant de document manquant." }, { status: 422 });
    const deleted = await deleteKnowledgeDocument(user.uid, id);
    if (!deleted) return NextResponse.json({ error: "Document introuvable." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible"), { status: errorStatus(error, 500) });
  }
}

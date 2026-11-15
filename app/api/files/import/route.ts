import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { ATTACHMENT_MAX_FILE_BYTES } from "@/lib/files/attachment-policy";
import {
  convertPermanentFile,
  convertUploadedFile,
  persistImportedFile,
  importedFileView,
  isOwnedPermanentKey,
} from "@/lib/files/import";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Import de fichier RÉEL : le fichier est réellement converti (texte, CSV →
 * lignes, JSON → structure, XLSX, DOCX, HTML, PDF natif) puis stocké dans la
 * base de données du projet (Firestore, collection `importedFiles`). La vue
 * renvoyée au client ne contient jamais le texte intégral — il reste servi
 * côté serveur au modèle.
 *
 * DEUX canaux (politique unifiée 10 fichiers × 50 Mo) :
 *  - FormData { file } : canal direct (fichiers ≤ limite de corps serverless) ;
 *  - JSON { path, filename, contentType?, sizeBytes? } : canal R2 — le
 *    fichier a DÉJÀ été téléversé dans le stockage permanent (multipart
 *    présigné, aucune limite de corps) ; le serveur le télécharge depuis R2
 *    puis le convertit. Les 50 Mo par fichier passent réellement.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`files-import:${user.uid}:${clientIp(request)}`, {
      limit: 60,
      windowMs: 60_000,
    });
    if (!limit.allowed) return NextResponse.json({ error: "Trop d'imports. Réessayez dans un instant." }, { status: 429 });

    const contentTypeHeader = request.headers.get("content-type") ?? "";
    if (contentTypeHeader.includes("application/json")) {
      // ── Canal R2 : fichier déjà téléversé dans le stockage permanent. ──
      const Body = z.object({
        path: z.string().trim().min(1).max(500),
        filename: z.string().trim().min(1).max(300),
        contentType: z.string().trim().max(160).optional(),
        sizeBytes: z.number().int().nonnegative().max(ATTACHMENT_MAX_FILE_BYTES).optional(),
        conversationId: z.string().trim().max(128).optional(),
        projectId: z.string().trim().max(128).optional(),
      });
      const body = Body.parse(await request.json());
      if (!isOwnedPermanentKey(user.uid, body.path)) {
        return NextResponse.json({ error: "Chemin de stockage invalide pour ce compte." }, { status: 403 });
      }
      const { conversion } = await convertPermanentFile({
        userId: user.uid,
        path: body.path,
        filename: body.filename,
        ...(body.contentType ? { contentType: body.contentType } : {}),
      });
      const stored = await persistImportedFile({
        userId: user.uid,
        permanentDescriptor: {
          path: body.path,
          filename: body.filename,
          contentType: body.contentType || "application/octet-stream",
          sizeBytes: body.sizeBytes ?? 0,
        },
        conversion,
        ...(body.conversationId ? { conversationId: body.conversationId } : {}),
        ...(body.projectId ? { projectId: body.projectId } : {}),
      });
      return NextResponse.json({ file: importedFileView(stored) }, { status: 201 });
    }

    // ── Canal direct : FormData (compatibilité historique conservée). ──
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 400 });

    const conversationId = typeof form.get("conversationId") === "string" ? String(form.get("conversationId")).slice(0, 128) : undefined;
    const projectId = typeof form.get("projectId") === "string" ? String(form.get("projectId")).slice(0, 128) : undefined;

    const conversion = await convertUploadedFile(file);
    const stored = await persistImportedFile({
      userId: user.uid,
      file,
      conversion,
      conversationId,
      projectId,
    });
    return NextResponse.json({ file: importedFileView(stored) }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import du fichier impossible" },
      { status: errorStatus(error, 400) },
    );
  }
}

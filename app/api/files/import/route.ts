import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import {
  convertUploadedFile,
  persistImportedFile,
  importedFileView,
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
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`files-import:${user.uid}:${clientIp(request)}`, {
      limit: 30,
      windowMs: 60_000,
    });
    if (!limit.allowed) return NextResponse.json({ error: "Trop d'imports. Réessayez dans un instant." }, { status: 429 });

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

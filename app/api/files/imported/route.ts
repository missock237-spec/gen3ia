import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { listImportedFiles } from "@/lib/files/import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liste des fichiers importés (métadonnées réelles — le texte reste côté serveur). */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const files = await listImportedFiles(user.uid, 50);
    return NextResponse.json({ files }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Liste impossible" },
      { status: errorStatus(error, 400) },
    );
  }
}

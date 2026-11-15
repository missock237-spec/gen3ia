import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

import { getProject } from "@/lib/training/repository";
import { ipFromRequest, recordTrainingAudit } from "@/lib/training/audit";
import { exportDownloadUrl } from "@/lib/training/exports";

/**
 * GET /api/training/exports/[exportId]?projectId=…
 * Renvvoie l'URL signée TEMPORAIRE du ZIP préparé (expiration configurable,
 * défaut 30 min). Vérifie la propriété AVANT toute signature (spec §11).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ exportId: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { exportId } = await params;
    const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
    if (!projectId) {
      return NextResponse.json(
        { error: "projectId requis en paramètre de requête.", requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }
    const project = await getProject(user.uid, projectId);
    if (!project) {
      return NextResponse.json({ error: "Projet introuvable.", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }
    const result = await exportDownloadUrl(user.uid, projectId, exportId);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, requestId },
        { status: result.status, headers: { "x-request-id": requestId } },
      );
    }
    void recordTrainingAudit({
      uid: user.uid,
      action: "export.downloaded",
      entityType: "export",
      entityId: exportId,
      projectId,
      ip: ipFromRequest(request),
    }).catch(() => undefined);
    return NextResponse.json({ url: result.url, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Lien d'export indisponible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}

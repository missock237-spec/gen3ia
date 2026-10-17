import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";

import { getProject } from "@/lib/training/repository";
import { prepareExport } from "@/lib/training/exports";

const createExportSchema = z.object({
  projectId: z.string().min(1),
  kind: z.enum(["dataset-archive", "model-files", "plan-config"]),
});

/** POST /api/training/exports — prépare un export (ZIP) du projet, lien temporaire à suivre. */
export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const body = (await request.json().catch(() => null)) as unknown;
    const parsed = createExportSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Requête d'export invalide : projectId et kind (dataset-archive | model-files | plan-config).", requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }
    const project = await getProject(user.uid, parsed.data.projectId);
    if (!project) {
      return NextResponse.json({ error: "Projet introuvable.", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }

    // Un export consomme du CPU (ZIP) : 10 par heure et par utilisateur.
    const limit = await enforceRateLimit(`training-export:${user.uid}`, { limit: 10, windowMs: 60 * 60_000 });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop d'exports demandés : réessayez plus tard.", requestId },
        { status: 429, headers: { "x-request-id": requestId } },
      );
    }

    const result = await prepareExport(user.uid, parsed.data.projectId, parsed.data.kind);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, requestId },
        { status: 409, headers: { "x-request-id": requestId } },
      );
    }
    return NextResponse.json(
      { export: result.artifact, requestId },
      { status: 201, headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Préparation de l'export impossible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}

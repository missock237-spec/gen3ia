import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

import { ipFromRequest, recordTrainingAudit } from "@/lib/training/audit";
import {
  lancerSessionArene,
  type ModeArene,
  type SessionArene,
} from "@/lib/training/arene-orchestrator";
import { getModel, getProject, saveSessionArene, listSessionsArene } from "@/lib/training/repository";

/** GET /api/training/projects/[id]/arene — liste des sessions d'arène du projet. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const project = await getProject(user.uid, id);
    if (!project) {
      return NextResponse.json({ error: "Projet introuvable.", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }
    const sessions = await listSessionsArene<SessionArene>(user.uid, id);
    return NextResponse.json({ sessions, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Liste des sessions d'arène indisponible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}

/**
 * POST /api/training/projects/[id]/arene
 * Lance une session d'arène d'interférence : le modèle élève du projet
 * (artefact gen3-language-model) affronte le professeur (Gen3 ou un
 * second modèle), la physique juge chaque réponse et distille le savoir
 * par ondes. Toutes les métriques retournées sont MESURÉES.
 *
 * Corps JSON : { mode, eleveAssetId, professeurAssetId?, roundsMax? }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const project = await getProject(user.uid, id);
    if (!project) {
      return NextResponse.json({ error: "Projet introuvable.", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }

    const body = (await request.json().catch(() => null)) as {
      mode?: unknown;
      eleveAssetId?: unknown;
      professeurAssetId?: unknown;
      roundsMax?: unknown;
    } | null;

    const mode: ModeArene = body?.mode === "duel-modeles" ? "duel-modeles" : "eleve-contre-gen3";
    const eleveAssetId = typeof body?.eleveAssetId === "string" ? body.eleveAssetId : "";
    const professeurAssetId = typeof body?.professeurAssetId === "string" ? body.professeurAssetId : "";
    const roundsMax = typeof body?.roundsMax === "number" ? Math.round(body.roundsMax) : undefined;

    if (!eleveAssetId) {
      return NextResponse.json(
        { error: "Asset modèle de l'élève manquant (eleveAssetId).", requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }

    const eleve = await getModel(user.uid, id, eleveAssetId);
    if (!eleve) {
      return NextResponse.json({ error: "Modèle élève introuvable.", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }
    let professeur: { id: string; name: string; storageKey?: string | null } | undefined;
    if (mode === "duel-modeles") {
      if (!professeurAssetId) {
        return NextResponse.json(
          { error: "Mode duel : professeurAssetId requis.", requestId },
          { status: 400, headers: { "x-request-id": requestId } },
        );
      }
      const asset = await getModel(user.uid, id, professeurAssetId);
      if (!asset) {
        return NextResponse.json({ error: "Modèle professeur introuvable.", requestId }, { status: 404, headers: { "x-request-id": requestId } });
      }
      professeur = asset;
    }

    const session = await lancerSessionArene(
      user.uid,
      id,
      { mode, eleveAssetId, professeurAssetId: professeurAssetId || undefined, roundsMax },
      { eleve, professeur },
    );
    await saveSessionArene(user.uid, id, session.id, session);

    void recordTrainingAudit({
      uid: user.uid,
      action: "arene.session",
      entityType: "arene",
      entityId: session.id,
      projectId: id,
      ip: ipFromRequest(request),
      details: {
        mode,
        eleve: eleve.name,
        roundsJoues: session.metriques.roundsJoues,
        distillees: session.metriques.distillees,
        rewardMoyen: session.metriques.rewardMoyen,
      },
    }).catch(() => undefined);

    return NextResponse.json({ session, requestId }, { status: 201, headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Session d'arène impossible"), requestId },
      { status: errorStatus(error, 400), headers: { "x-request-id": requestId } },
    );
  }
}

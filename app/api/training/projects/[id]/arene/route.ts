import { NextRequest, NextResponse } from "next/server";

import { requireSystemAccess } from "@/app/api/training/_internal/system-only";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";

import { ipFromRequest, recordTrainingAudit } from "@/lib/training/audit";
import {
  lancerSessionArene,
  type ModeArene,
  type SessionArene,
} from "@/lib/training/arene-orchestrator";
import { getModel, getProject, saveSessionArene, listSessionsArene } from "@/lib/training/repository";

/** GET /api/training/projects/[id]/arene — SYSTÈME-ONLY (demande n° 6) : liste des sessions d'arène du projet.
 *
 * Le lanceur d'arène est de la mécanique interne brute (chargement/réécriture
 * directs d'états de modèles, hors flux plan → acceptation → orchestrateur) :
 * 403 JSON clair pour un utilisateur standard, 401 si non authentifié.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
  try {
    const user = await requireSystemAccess(request);
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
 * POST /api/training/projects/[id]/arene — SYSTÈME-ONLY (demande n° 6).
 *
 * Lance une session d'arène d'interférence : le modèle élève du projet
 * (artefact gen3-language-model) affronte le professeur (Gen3 ou un
 * second modèle), la physique juge chaque réponse et distille le savoir
 * par ondes. Toutes les métriques retournées sont MESURÉES.
 *
 * Ce lanceur direct de calcul (contournant le flux config → analyse → plan
 * → acceptation et le budget de minutes) relève de la mécanique interne :
 * 403 JSON clair pour un utilisateur standard via `requireSystemAccess`.
 *
 * Corps JSON : { mode, eleveAssetId, professeurAssetId?, roundsMax? }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
  try {
    const user = await requireSystemAccess(request);
    const { id } = await params;

    // Anti-abus : une session dure au plus 1 h (timebox) — trois
    // lancements par heure et par compte suffisent largement, même
    // pour un usage intensif ; un agent automatisé ne peut pas
    // transformer l'arène en ferme de calcul non autorisée.
    const limite = await enforceRateLimit("arene-session:" + user.uid, { limit: 3, windowMs: 60 * 60 * 1000 });
    if (!limite.allowed) {
      return NextResponse.json(
        {
          error: `Trop de sessions d'arène : réessayez dans ${Math.max(1, Math.ceil(limite.retryAfterMs / 60000))} min.`,
          requestId,
        },
        { status: 429, headers: { "x-request-id": requestId } },
      );
    }

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

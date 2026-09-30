import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { listRecentRuns } from "@/lib/domain/runs/repository";

export const runtime = "nodejs";

/**
 * Étape 16 — Missions récentes TOUTES conversations confondues : la vue
 * globale de l'activité d'exécution (objective, statut, avancement,
 * conversation d'origine pour y sauter). Propriété stricte (requireUser).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limitParam = Number(request.nextUrl.searchParams.get("limit") ?? "8");
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(1, Math.floor(limitParam)), 20) : 8;
    const runs = await listRecentRuns(user.uid, limit);
    return NextResponse.json({
      missions: runs.map((run) => {
        const steps = run.steps ?? [];
        const done = steps.filter((step) => step.status === "done").length;
        return {
          id: run.id,
          conversationId: run.conversationId,
          objective: run.objective,
          status: run.status,
          stepsDone: done,
          stepsTotal: steps.length,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        };
      }),
    });
  } catch (error) {
    return NextResponse.json({ ...errorBody(error, "Missions indisponibles") }, { status: errorStatus(error) });
  }
}

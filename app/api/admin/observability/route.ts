import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/observability — santé plateforme (admin uniquement) :
 * exécutions récentes, consommation IA agrégée et erreurs les plus fréquentes.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  const { adminDb } = await import("@/lib/firebase/admin");

  const executions: Array<Record<string, unknown>> = [];
  try {
    const snapshot = await adminDb.collection("executions").limit(40).get();
    for (const doc of snapshot.docs) {
      const data = doc.data() ?? {};
      executions.push({
        id: doc.id,
        userId: typeof data.userId === "string" ? data.userId : null,
        kind: typeof data.kind === "string" ? data.kind : null,
        status: typeof data.status === "string" ? data.status : null,
        createdAt: data.createdAt ?? null,
      });
    }
  } catch {
    /* liste vide en cas de panne */
  }

  let usageTotal = { requests: 0, costMinor: 0 };
  try {
    // Task 102-a — QUOTA : lecture de la collection agrégée "usageDaily"
    // (1 document par utilisateur et par jour UTC, ID `${userId}_${YYYYMMDD}`)
    // au lieu de "usage" (1 document par appel IA). Limite 200 = 200
    // jours-utilisateurs récents, là où l'ancien code lisait 200 appels :
    // même budget de lectures, mais chaque document couvre désormais N appels
    // — requests = Σ des compteurs "calls" (le lecteur d'aujourd'hui ne lit
    // plus 200 appels mais l'agrégat de 200 jours-utilisateurs).
    // TRANSITION : les anciens documents "usage" ne sont plus lus —
    // l'historique par appel devient inaccessible côté admin ; l'agrégat
    // courant est identique ou meilleur (appels cumulés au lieu d'un simple
    // comptage de documents, plafonné à 200).
    const snapshot = await adminDb.collection("usageDaily").limit(200).get();
    usageTotal = snapshot.docs.reduce(
      (accumulator, doc) => {
        const data = doc.data() ?? {};
        // Σ des appels agrégés ; repli : 1 par document si "calls" est absent
        // (compatibilité avec d'éventuels documents sans compteur).
        const calls = typeof data.calls === "number" ? data.calls : 1;
        const cost = typeof data.costMinor === "number" ? data.costMinor : typeof data.costUsd === "number" ? Math.round(data.costUsd * 100) : 0;
        return {
          requests: accumulator.requests + calls,
          costMinor: accumulator.costMinor + cost,
        };
      },
      { requests: 0, costMinor: 0 },
    );
  } catch {
    /* agrégat indisponible */
  }

  const statusCounts: Record<string, number> = {};
  for (const execution of executions) {
    const status = String(execution.status ?? "unknown");
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }

  return NextResponse.json(
    { executions, usage: usageTotal, statusCounts, generatedAt: Date.now() },
    { headers: { "cache-control": "no-store" } },
  );
}

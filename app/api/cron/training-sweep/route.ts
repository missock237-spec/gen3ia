import { NextRequest, NextResponse } from "next/server";

import { errorStatus } from "@/lib/security/http-errors";
import { requireService } from "@/lib/security/service-identity";
import { timingSafeStringEqual } from "@/lib/security/timing-safe";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;

  const authorization = request.headers.get("authorization") ?? "";
  // Comparaison à temps constant (pas de court-circuit exploitable).
  return timingSafeStringEqual(authorization, `Bearer ${secret}`);
}

/**
 * AUTHENTIFICATION DU SERVICE APPELANT (Pilier 3 — Zero Trust) : la
 * signature d'identité de service (lib/security/service-identity.ts) est
 * acceptée EN PLUS du bearer CRON_SECRET historique — jamais à sa place.
 * GEN3IA_SERVICE_TOKENS absente → bearer seul, comportement inchangé
 * (rétrocompatibilité stricte, warning loggé par le module).
 */
function estAutorisee(request: NextRequest): boolean {
  return requireService(request, "cron").ok || isAuthorized(request);
}

/**
 * CRON Training Studio — balayage global des tâches d'entraînement.
 *
 * Le sweep opportuniste (déclenché par les routes de listing quand
 * l'utilisateur consulte son projet) ne progresse que l'onglet ouvert.
 * Ce passage poursuit le dispatch des tâches en attente et le
 * rafraîchissement des tâches en cours pour TOUS les utilisateurs,
 * même onglet fermé — indispensable dès qu'un worker GPU est câblé
 * (TRAINING_WORKER_URL) : une tâche qui tourne depuis des heures doit
 * aboutir sans exiger la présence du propriétaire.
 *
 * Best-effort total (pattern agent-schedules) : un incident par
 * utilisateur alimente `failures` sans faire échouer la route.
 * L'import de la machinerie de sweep est DYNAMIQUE (la route doit
 * rester légère au démarrage).
 */
export async function GET(request: NextRequest) {
  if (!estAutorisee(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { sweepAllTrainingJobs } = await import("@/lib/training/sweep");
    const result = await sweepAllTrainingJobs();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Training sweep failed", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Training sweep failed" },
      { status: errorStatus(error, 500) },
    );
  }
}

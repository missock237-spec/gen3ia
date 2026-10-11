import { NextResponse } from "next/server";

import { getAdminApp } from "@/lib/firebase/admin";
import { pingR2 } from "@/lib/storage/r2";
import { tickQueueConfigured } from "@/lib/queue/tick-queue";

/**
 * GET /api/status — STATUT PUBLIC pour moniteurs d'uptime entreprise
 * (Task 126). NON authentifié, volontairement sans donnée sensible.
 *
 * Réponse : { status: "ok"|"degraded", version, services: { auth, r2, ticks } }
 *   - auth  : initialisation Firebase Admin (compte de service présent) ;
 *   - r2    : sonde pingR2 (ListObjects borné 3 s) ;
 *   - ticks : file de ticks R2 activable (config complète) ET stockage R2
 *             joignable.
 *
 * Code HTTP : 200 quand tout va bien, 503 dès qu'un service est dégradé —
 * les moniteurs d'uptime standards (ping HTTP) alertent sans avoir à parser
 * le corps ; les corps JSON { status, services } restent consommables par
 * les sondes avancées.
 *
 * CACHE 30 s (s-maxage) : la sonde est protégée des rafales de polling ;
 * `stale-while-revalidate` sert le cache pendant le re-remplissage. Complète
 * /api/health (heartbeat ultra-léger sans dépendance) et /api/health/infra
 * (détails complets, protégé).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Empreinte de version — même chaîne de repli que /api/deploy-info. */
function resolveVersion(): string {
  return (
    process.env.VERCEL_DEPLOYMENT_ID ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GEN3IA_RELEASE ||
    "local-dev"
  );
}

interface ServiceHealth {
  ok: boolean;
  /** Raison stable de dégradation : "not_configured" | "timeout" | "error". */
  reason?: string;
}

function authHealth(): ServiceHealth {
  try {
    getAdminApp();
    return { ok: true };
  } catch {
    return { ok: false, reason: "not_configured" };
  }
}

export async function GET() {
  // R2 est sondé UNE fois : il fonde à la fois le service « r2 » et le
  // service « ticks » (les tickets vivent dans le même bucket).
  const r2 = await pingR2(3_000);
  const ticks: ServiceHealth = tickQueueConfigured()
    ? { ok: r2.ok, reason: r2.reason }
    : { ok: false, reason: "not_configured" };
  const auth = authHealth();

  const services = { auth, r2, ticks };
  const degraded = !auth.ok || !r2.ok || !ticks.ok;

  return NextResponse.json(
    {
      status: degraded ? "degraded" : "ok",
      version: resolveVersion(),
      services,
      checkedAt: new Date().toISOString(),
    },
    {
      status: degraded ? 503 : 200,
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=15" },
    },
  );
}

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — sonde de disponibilité publique (uptime monitoring).
 *
 * Volontairement minimaliste : aucune dépendance externe (Firestore, Redis,
 * providers), aucune authentification, aucune donnée sensible. Répond en
 * quelques millisecondes pour servir de heartbeat aux moniteurs externes
 * (Vercel, UptimeRobot, checks CI). Les vérifications d'infrastructure
 * détaillées restent dans /api/health/infra (protégé).
 */
export async function GET() {
  return NextResponse.json(
    { status: "ok", timestamp: new Date().toISOString() },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

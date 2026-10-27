import { NextResponse } from "next/server";

import { sonderServices } from "@/lib/observability/statut-services";

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
 *
 * SOURCE UNIQUE (durcissement production) : les sondes vivent désormais dans
 * lib/observability/statut-services.ts — la page publique /status consomme LE
 * MÊME code, garantissant la cohérence entre la vue utilisateur et la sonde
 * machine.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const statut = await sonderServices();
  const degraded = statut.status === "degraded";

  return NextResponse.json(statut, {
    status: degraded ? 503 : 200,
    headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=15" },
  });
}

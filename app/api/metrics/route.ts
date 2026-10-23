import { NextRequest, NextResponse } from "next/server";

import { formaterPrometheus } from "@/lib/observability/metrics-registry";
import { timingSafeStringEqual } from "@/lib/security/timing-safe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/metrics — SLI au format TEXTE PROMETHEUS (Task G — SRE).
 *
 * Source : lib/observability/metrics-registry.ts (registre in-memory sur
 * globalThis, alimenté par le hook du middleware) — compteurs de requêtes
 * par classe de route × famille de statut, latence moyenne glissante (ring
 * buffer 500), uptime, mémoire (RSS / tas V8). Données 100 % numériques :
 * AUCUN path utilisateur, AUCUN identifiant, AUCUN secret n'y figure.
 *
 * AUTHENTIFICATION (défense proportionnée) :
 *  - METRICS_TOKEN ABSENT  → endpoint ouvert (scraping local par un
 *    collecteur sur le VPS, cf. docs/sre/sli-slo.md) ;
 *  - METRICS_TOKEN DÉFINI  → Authorization: Bearer <token> OBLIGATOIRE
 *    (comparaison à temps constant, même convention que les routes /api/cron) ;
 *    toute autre requête reçoit 401.
 *
 * RECOMMANDATION PRODUCTION (VPS actuel) : définir METRICS_TOKEN et
 * limiter le scraping à la boucle locale — nginx doit refuser /api/metrics
 * depuis l'extérieur (ou exiger le Bearer côté collecteur uniquement).
 * Le collecteur/scrapeur reste LOCAL au VPS (curl / node_exporter textfile),
 * jamais exposé publiquement.
 */
export async function GET(request: NextRequest) {
  const token = process.env.METRICS_TOKEN?.trim();
  if (token) {
    const authorization = request.headers.get("authorization") ?? "";
    // Comparaison à temps constant (pas de court-circuit exploitable).
    if (!timingSafeStringEqual(authorization, `Bearer ${token}`)) {
      return NextResponse.json(
        {
          success: false,
          error: "Jeton de métriques requis : en-tête « Authorization: Bearer <METRICS_TOKEN> ».",
        },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  return new NextResponse(formaterPrometheus(), {
    status: 200,
    headers: {
      // Format d'exposition Prometheus 0.0.4 (texte). no-store : chaque
      // scrape doit lire l'état COURANT du process (jamais un cache).
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

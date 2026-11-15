import { NextRequest, NextResponse } from "next/server";

import { estActive } from "@/lib/flags/feature-flags";
import { clientIp } from "@/lib/security/rate-limit";
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
 *
 * FEATURE FLAG — GEN3IA_FLAG_SLI_ENDPOINT (Task M, lib/flags/) : premier
 * exemple réel du système de flags. Défaut ACTIF (aucun changement de
 * comportement pour les déploiements existants) ; KILL-SWITCH D'URGENCE
 * : passer la variable à 0 dans .env.production puis `pm2 restart gen3ia`
 * désactive l'endpoint (404 JSON propre) sans redéploiement — usage en
 * cas d'incident où l'exposition elle-même devient suspecte. La COLLECTE
 * en mémoire du registre (middleware) continue quoi qu'il en soit : seule
 * l'exposition est coupée, aucun compteur n'est perdu.
 */
export async function GET(request: NextRequest) {
  // Kill-switch d'urgence (GEN3IA_FLAG_SLI_ENDPOINT, défaut actif) : la
  // désactivation coupe l'EXPOSITION des métriques, pas leur collecte.
  if (!estActive("SLI_ENDPOINT")) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Endpoint /api/metrics désactivé (GEN3IA_FLAG_SLI_ENDPOINT=0) — " +
          "kill-switch d'urgence du flag SLI_ENDPOINT (lib/flags/feature-flags.ts).",
      },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

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
  } else if (process.env.NODE_ENV === "production") {
    // FAIL-CLOSED DE LA BOUCLE EXTERNE (durcissement audit 2026-10-28) :
    // sans METRICS_TOKEN, l'exposition se limite au scraping LOCAL du VPS
    // (collecteur sur la boucle, cf. docs/sre/sli-slo.md). Une requête
    // venant d'Internet (x-real-ip posé par nginx depuis la connexion TCP,
    // non falsifiable — lib/security/rate-limit.ts clientIp) reçoit 403 :
    // les compteurs (uptime, mémoire, routes) ne sont plus une surface
    // publique. Le scraping local (127.0.0.1 / ::1) reste inchangé.
    const ip = clientIp(request);
    const local = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (!local) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Métriques réservées au collecteur local en production — définissez METRICS_TOKEN " +
            "et scrapez avec « Authorization: Bearer <METRICS_TOKEN> » depuis l'extérieur.",
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  return new NextResponse(await formaterPrometheus(), {
    status: 200,
    headers: {
      // Format d'exposition Prometheus 0.0.4 (texte). no-store : chaque
      // scrape doit lire l'état COURANT du process (jamais un cache).
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

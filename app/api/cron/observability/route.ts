import { NextResponse } from "next/server";

import { verifyTickRequest } from "@/lib/queue/tick-queue";
import { checkAndAlert } from "@/lib/observability/alerts";
import { getSystemHealth } from "@/lib/observability/metrics";
import { instantane } from "@/lib/observability/metrics-registry";
import { instantaneSelfReview } from "@/lib/observability/self-review-metrics";
import { instantaneConcurrence } from "@/lib/security/concurrency";
import { executionLogger } from "@/lib/observability/logger";

/**
 * SENTINELLE D'OBSERVABILITÉ (durcissement production — niveau enterprise) :
 * POST /api/cron/observability
 *
 * Le moteur d'alertes (lib/observability/alerts.ts — règles + cooldowns +
 * canaux logger pino/Sentry) existait mais n'était ÉVALUÉ nulle part : du
 * code mort. Cette sentinelle le branche au battement de la plateforme :
 * toutes les 5 minutes (cron vercel.json + worker de ticks VPS), elle
 * compose des métriques 100 % RÉELLES —
 *   - taux d'erreur HTTP 5xx : registre SLI process (metrics-registry) ;
 *   - latence : moyenne glissante la plus défavorable des classes de route
 *     (proxy conservateur du P95 — le P95 exact vit dans les logs nginx, cf.
 *     docs/sre/sli-slo.md) ;
 *   - pression mémoire : heap V8 réel ;
 *   - santé de la barrière anti-désinformation : part de passes de
 *     self-review en erreur parmi les passes effectives ;
 *   - saturation de la garde de concurrence : refus 429 observés.
 * … puis déclenche les règles (critical → logger.error + Sentry).
 *
 * CONTRAT D'AUTH : identique aux autres routes /api/cron — bearer
 * CRON_SECRET ou signature de tick interne (verifyTickRequest, comparaison
 * à temps constant). Aucune donnée utilisateur n'est lue ni exposée.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifyTickRequest(raw, request.headers.get("authorization"), request.headers.get("x-gen3a-tick"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const photo = instantane();
  const totalHttp = photo.compteurs.reduce((somme, serie) => somme + serie.total, 0);
  const erreurs5xx = photo.compteurs
    .filter((serie) => serie.statut === "5xx")
    .reduce((somme, serie) => somme + serie.total, 0);
  const errorRate = totalHttp > 0 ? erreurs5xx / totalHttp : 0;

  // Proxy conservateur du P95 : la moyenne glissante la plus élevée des
  // classes de route (jamais une fabrication — nommée « proxy » dans les
  // alertes et la doc SRE).
  const p95Proxy = photo.durees.reduce((max, serie) => Math.max(max, serie.moyenneMs), 0);

  const health = getSystemHealth();
  const heapUsedRatio = health.memory.heapUsedMb / Math.max(1, health.memory.heapTotalMb);

  // Barrière anti-désinformation : ratio d'erreur parmi les passes
  // EFFECTIVES (undefined tant qu'aucune passe — pas d'alerte prématurée).
  const revue = instantaneSelfReview();
  const passesEffectives = revue.conforme + revue.ameliore + revue.error;
  const selfReviewErrorRatio =
    passesEffectives > 0 ? revue.error / passesEffectives : undefined;

  // Garde de charge : saturation observée (des 429 viennent d'être émis).
  const concurrence = instantaneConcurrence();
  const concurrencySaturated = concurrence.totalRefuses > 0 && concurrence.actifs >= concurrence.maximum;

  const declenchees = await checkAndAlert({
    errorRate,
    p95LatencyMs: p95Proxy,
    // Fenêtre agents : compteur dédié à venir (file R2 ne persiste pas ses
    // dead-letters en jauge) — laissé à 0 HONNÊTEMENT plutôt qu'inventé.
    agentFailureRate: 0,
    tokenUsageRatio: 0,
    heapUsedRatio,
    ...(selfReviewErrorRatio !== undefined ? { selfReviewErrorRatio } : {}),
    concurrencySaturated,
  });

  const log = executionLogger({ executionId: "observability-sentinel" });
  log.info(
    {
      service: "gen3ia-observability-sentinel",
      errorRate,
      p95ProxyMs: p95Proxy,
      heapUsedRatio,
      selfReviewErrorRatio: selfReviewErrorRatio ?? null,
      concurrencySaturated,
      declenchees,
      uptimeSec: health.uptimeSec,
    },
    "observability_sentinel_tick",
  );

  return NextResponse.json({
    success: true,
    evaluated: {
      errorRate,
      p95ProxyMs: p95Proxy,
      heapUsedRatio,
      selfReviewErrorRatio: selfReviewErrorRatio ?? null,
      concurrencySaturated,
      httpRequests: totalHttp,
    },
    alerts: declenchees,
  });
}

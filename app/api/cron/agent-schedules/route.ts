import { NextRequest, NextResponse } from "next/server";

import { dispatchSchedules } from "@/lib/agents/scheduler";
import { renewDueNumbers, reactivateNumbersInGrace } from "@/lib/voice/renewals";
import { renewDueExtensionSubscriptions } from "@/lib/extensions/subscriptions";
import { errorStatus } from "@/lib/security/http-errors";
import { timingSafeStringEqual } from "@/lib/security/timing-safe";
import { scheduleNextDispatchTick, slotFor } from "@/lib/queue/dispatch-loop";
import { enqueueDispatchTick, pumpDueTicks } from "@/lib/queue/tick-queue";

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
 * Dispatcher d'arrière-plan (déclencheurs) :
 *  1. planifications d'agents arrivées à échéance (claim transactionnel + bail) ;
 *  2. veille RSS/web des agents « toujours actifs » ;
 *  3. renouvellement mensuel des numéros virtuels (débit wallet, grâce,
 *     libération) — idempotent par période de facturation ;
 *  4. SENTINELLE de résurrection de la boucle de dispatch 5 minutes
 *     (Task 62) : le plan Vercel Hobby limite le cron à UNE exécution
 *     journalière (vercel.json `0 6 * * *`) — la cadence 5 minutes est
 *     assurée par la boucle auto-perpétuelle de la FILE DE TICKS R2
 *     (/api/queue/dispatch-tick + pump opportuniste sur le polling client),
 *     et CETTE route la relance si elle est morte (publish du tick du
 *     prochain slot si absent) et RATTRAPE les tickets dus non consommés
 *     (délivrances interrompues pendant la nuit). Le dispatch
 *     étant idempotent par slot (claims transactionnels), le double
 *     déclencheur quotidien + boucle ne peut jamais exécuter deux fois
 *     une même planification.
 *  5. Task 107-a — AUTO-RÉPARATION des files vidéo (production autopilote
 *     + rendu) : les jobs orphelins (bail expiré, worker tué, tick perdu)
 *     sont re-enfilés même quand le chat est fermé (mode sondage — la
 *     continuation ne doit pas dépendre d'un client vivant). Best-effort :
 *     un incident alimente `partialFailures` sans faire échouer la route.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const failures: string[] = [];

  try {
    const result = await dispatchSchedules(new Date());
    const renewals = await renewDueNumbers(new Date()).catch((error: unknown) => {
      failures.push(`renewals: ${error instanceof Error ? error.message : "erreur"}`);
      return null;
    });
    const reactivations = await reactivateNumbersInGrace(new Date()).catch((error: unknown) => {
      failures.push(`reactivations: ${error instanceof Error ? error.message : "erreur"}`);
      return null;
    });
    // Renouvellement auto des abonnements d'extensions (Task 80) :
    // débit wallet dans la fenêtre d'avance, grâce 7 jours, expiration finale.
    const extensionRenewals = await renewDueExtensionSubscriptions(new Date()).catch((error: unknown) => {
      failures.push(`extension-renewals: ${error instanceof Error ? error.message : "erreur"}`);
      return null;
    });

    // Sentinelle de résurrection (Task 62) : le prochain slot de la boucle
    // doit TOUJOURS être programmé après ce passage — même si la boucle
    // de dispatch est morte depuis la veille. NB (fix request-forgery) :
    // enqueueDispatchTick résout l'ORIGINE CANONIQUE en interne ; le
    // paramètre origin de scheduleNextDispatchTick est ignoré par celle-ci
    // (signature conservée — voir lib/queue/dispatch-loop.ts).
    const origin = process.env.GEN3IA_APP_ORIGIN?.trim() || request.nextUrl.origin;
    const loop = await scheduleNextDispatchTick(origin, slotFor(Date.now()), Date.now(), (options) =>
      enqueueDispatchTick(options).then((published) =>
        published.ok ? { messageId: published.messageId } : null,
      ),
    ).catch((error: unknown) => {
      failures.push(`dispatch-loop: ${error instanceof Error ? error.message : "erreur"}`);
      return null;
    });

    // RATTRAPAGE DES TICKETS DUS (file de ticks R2 — ex-QStash) : les
    // délivrances interrompues pendant la nuit (fonction tuée, self-fetch
    // perdu) sont re-délivrées ici ; les tickets sains ne sont pas dus ou
    // sont sous bail → no-op. Best-effort : un incident alimente
    // `partialFailures` sans faire échouer la route.
    const queuePump = await pumpDueTicks().catch((error: unknown) => {
      failures.push(`queue-pump: ${error instanceof Error ? error.message : "erreur"}`);
      return null;
    });

    // Task 107-a — auto-réparation des files vidéo : sweep des jobs de
    // production autopilote ORPHELINS (bail expiré → ré-enfilement via
    // publishProductionTick + repli sondage) et des jobs de rendu dans le
    // même état. Imports DYNAMIQUES (la machinerie vidéo — engines, FFmpeg —
    // ne doit pas alourdir le démarrage de la route) et best-effort total :
    // un incident (import, lecture, ré-file) alimente `partialFailures`.
    const videoSweep = await (async () => {
      try {
        const production = await import("@/lib/video/production-queue");
        const productionSweep = await production.sweepStaleProductionJobs();
        const render = await import("@/lib/video/render-queue");
        const renderSweep = await render.sweepStaleRenderJobs();
        return { production: productionSweep, render: renderSweep };
      } catch (error) {
        failures.push(`video-sweep: ${error instanceof Error ? error.message : "erreur"}`);
        return null;
      }
    })();

    // Task 114-a — purge des escrows de mission expirés : les holds encore
    // « held » au-delà de leur TTL (GEN3IA_ESCROW_TTL_MS, défaut 7 jours) sont
    // LIBÉRÉS (wallet + registre walletHolds). Best-effort total : un
    // incident alimente `partialFailures` sans faire échouer la route.
    const escrowSweep = await (async () => {
      try {
        const { releaseExpiredEscrows } = await import("@/lib/billing/mission-escrow");
        return { released: await releaseExpiredEscrows(50) };
      } catch (error) {
        failures.push(`escrow-sweep: ${error instanceof Error ? error.message : "erreur"}`);
        return null;
      }
    })();

    return NextResponse.json({ ok: true, ...result, renewals, reactivations, extensionRenewals, dispatchLoop: loop, queuePump, videoSweep, escrowSweep, ...(failures.length > 0 ? { partialFailures: failures } : {}) });
  } catch (error) {
    console.error("Agent schedule dispatcher failed", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Dispatcher failed" },
      { status: errorStatus(error, 500) },
    );
  }
}

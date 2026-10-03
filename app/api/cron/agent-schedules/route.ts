import { NextRequest, NextResponse } from "next/server";

import { dispatchSchedules } from "@/lib/agents/scheduler";
import { renewDueNumbers, reactivateNumbersInGrace } from "@/lib/voice/renewals";
import { renewDueExtensionSubscriptions } from "@/lib/extensions/subscriptions";
import { errorStatus } from "@/lib/security/http-errors";
import { scheduleNextDispatchTick, slotFor } from "@/lib/queue/dispatch-loop";
import { publishDispatchTick } from "@/lib/queue/qstash";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;

  const authorization = request.headers.get("authorization") ?? "";
  return authorization === `Bearer ${secret}`;
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
 *     assurée par la boucle auto-perpétuelle QStash
 *     (/api/queue/dispatch-tick), et CETTE route la relance si elle est
 *     morte (publish du tick du prochain slot si absent). Le dispatch
 *     étant idempotent par slot (claims transactionnels), le double
 *     déclencheur quotidien + boucle ne peut jamais exécuter deux fois
 *     une même planification.
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
    // QStash est morte depuis la veille.
    const origin = process.env.GEN3IA_APP_ORIGIN?.trim() || request.nextUrl.origin;
    const loop = await scheduleNextDispatchTick(origin, slotFor(Date.now()), Date.now(), (options) =>
      publishDispatchTick(origin, options),
    ).catch((error: unknown) => {
      failures.push(`dispatch-loop: ${error instanceof Error ? error.message : "erreur"}`);
      return null;
    });

    return NextResponse.json({ ok: true, ...result, renewals, reactivations, extensionRenewals, dispatchLoop: loop, ...(failures.length > 0 ? { partialFailures: failures } : {}) });
  } catch (error) {
    console.error("Agent schedule dispatcher failed", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Dispatcher failed" },
      { status: errorStatus(error, 500) },
    );
  }
}

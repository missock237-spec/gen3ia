import { NextRequest, NextResponse } from "next/server";

import { dispatchSchedules } from "@/lib/agents/scheduler";
import { renewDueNumbers, reactivateNumbersInGrace } from "@/lib/voice/renewals";
import { errorStatus } from "@/lib/security/http-errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;

  const authorization = request.headers.get("authorization") ?? "";
  return authorization === `Bearer ${secret}`;
}

/**
 * Dispatcher d'arrière-plan (cron toutes les 5 minutes) :
 *  1. planifications d'agents arrivées à échéance (claim transactionnel + bail) ;
 *  2. veille RSS/web des agents « toujours actifs » ;
 *  3. renouvellement mensuel des numéros virtuels (débit wallet, grâce,
 *     libération) — idempotent par période de facturation.
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
    return NextResponse.json({ ok: true, ...result, renewals, reactivations, ...(failures.length > 0 ? { partialFailures: failures } : {}) });
  } catch (error) {
    console.error("Agent schedule dispatcher failed", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Dispatcher failed" },
      { status: errorStatus(error, 500) },
    );
  }
}

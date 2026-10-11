import { NextRequest, NextResponse } from "next/server";

import { pollJulesSessions } from "@/lib/integrations/jules/followup";
import { verifyTickRequest } from "@/lib/queue/tick-queue";
import { errorStatus } from "@/lib/security/http-errors";
import { timingSafeStringEqual } from "@/lib/security/timing-safe";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * SUIVI DES SESSIONS JULES (Task 121) — receiver de la file de ticks R2 ET
 * route cron.
 *
 * Jules (jules.google) travaille une session de code en quelques minutes :
 * chaque passage sonde les sessions actives (GET /sessions/{name}) et livre
 * le résultat dans la conversation d'origine DÈS qu'un état terminal est
 * observé (message + artefact, idempotents — miroir de la livraison vidéo
 * deliverJobToConversation). Tant qu'une session reste active, le passage
 * programme lui-même le prochain tick (boucle auto-perpétuée par la file de
 * ticks R2 — lib/queue/tick-queue.ts, non modifié).
 *
 * DEUX déclencheurs, même travail :
 *  - POST signé par la file de ticks (HMAC dérivé du secret R2) OU bearer
 *    CRON_SECRET — contrat commun aux receivers (/api/queue/mission-tick) ;
 *  - GET bearer CRON_SECRET — sonde externe / cron Vercel (comme les autres
 *    routes /api/cron/*).
 */

function isCronAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const authorization = request.headers.get("authorization") ?? "";
  // Comparaison à temps constant (pas de court-circuit exploitable).
  return timingSafeStringEqual(authorization, `Bearer ${secret}`);
}

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await pollJulesSessions();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Jules follow-up sweep failed", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Follow-up failed" },
      { status: errorStatus(error, 500) },
    );
  }
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const authorized = verifyTickRequest(rawBody, request.headers.get("authorization"), request.headers.get("x-gen3a-tick"));
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await pollJulesSessions();
    // 202 : délivrance acceptée, travail fait dans ce passage (contrat des
    // receivers — 2xx = ticket consommé, 5xx = re-délivrance backoff).
    return NextResponse.json({ ok: true, ...result }, { status: 202 });
  } catch (error) {
    console.error("Jules follow-up tick failed", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Follow-up failed" },
      { status: errorStatus(error, 500) },
    );
  }
}

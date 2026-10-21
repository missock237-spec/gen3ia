import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

// SYSTÈME AGENT RÉSERVÉ (demande n°5) : sonde de veille fermée aux
// utilisateurs standard (403 « réservé au système IA ») — admin conservé.
import { requireAgentSystemAccess } from "@/lib/security/agent-system-access";
import { errorStatus } from "@/lib/security/http-errors";
import { checkScheduleWatchSourcesForUser } from "@/lib/agents/scheduler";

/**
 * Vérification manuelle des sources de veille d'une planification
 * « toujours active » : force la sonde RSS/Web immédiatement (sans attendre
 * le cron) et déclenche l'agent si un contenu surveillé a changé.
 */

interface RouteContext { params: Promise<{ id: string }> }

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireAgentSystemAccess(request);
    const { id } = await context.params;
    const results = await checkScheduleWatchSourcesForUser(user.uid, id);
    return NextResponse.json({ ok: true, results, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Watch check failed";
    // errorStatus : HttpError (403 agent-système réservé) d'abord, sinon le
    // mapping message historique (404/400).
    const status = errorStatus(error, message === "Schedule not found" ? 404 : message.includes("no watch sources") ? 400 : 500);
    return NextResponse.json({ error: message, requestId }, { status, headers: { "x-request-id": requestId } });
  }
}

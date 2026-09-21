import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
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
    const user = await requireUser(request);
    const { id } = await context.params;
    const results = await checkScheduleWatchSourcesForUser(user.uid, id);
    return NextResponse.json({ ok: true, results, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Watch check failed";
    const status = message === "Schedule not found" ? 404 : message.includes("no watch sources") ? 400 : 500;
    return NextResponse.json({ error: message, requestId }, { status, headers: { "x-request-id": requestId } });
  }
}

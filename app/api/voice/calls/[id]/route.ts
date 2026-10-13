import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { TERMINAL_VOICE_CALL_STATUSES, assertVoiceCallOwner, syncVoiceCallFromBland } from "@/lib/voice/bland-calls";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Suivi d'un appel vocal (GET /api/voice/calls/{id}).
 *
 * Tant que l'appel n'est pas terminé (queued / in-progress), l'état est
 * rafraîchi en direct depuis l'API Bland — le polling de l'UI n'est que
 * le déclencheur, la donnée fait foi côté Bland. Une fois terminal, le
 * document local fait foi (mis à jour par le webhook post-appel).
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const record = await assertVoiceCallOwner(user.uid, id);
    const fresh = TERMINAL_VOICE_CALL_STATUSES.has(record.status)
      ? record
      : ((await syncVoiceCallFromBland(id)) ?? record);
    return NextResponse.json({
      id: fresh.id,
      agentId: fresh.agentId ?? null,
      agentName: fresh.agentName ?? null,
      status: fresh.status,
      completed: fresh.completed,
      to: fresh.to,
      from: fresh.from,
      objective: fresh.objective,
      language: fresh.language,
      answeredBy: fresh.answeredBy ?? null,
      callEndedBy: fresh.callEndedBy ?? null,
      lengthMinutes: fresh.lengthMinutes ?? null,
      recordingUrl: fresh.recordingUrl ?? null,
      summary: fresh.summary ?? null,
      resume: fresh.resume ?? null,
      history: fresh.history,
      createdAt: fresh.createdAt,
      updatedAt: fresh.updatedAt,
      lastError: fresh.lastError ?? null,
    });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Appel introuvable."), { status: errorStatus(error, 404) });
  }
}

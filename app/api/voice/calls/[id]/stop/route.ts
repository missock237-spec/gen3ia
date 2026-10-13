import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { stopBlandCall } from "@/lib/integrations/bland/client";
import { adminDb } from "@/lib/firebase/admin";
import { assertVoiceCallOwner } from "@/lib/voice/bland-calls";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Arrête un appel vocal en cours (POST /api/voice/calls/{id}/stop).
 *
 * L'arrêt est demandé à Bland (fin immédiate de la conversation), puis le
 * statut local passe à « canceled » — le webhook post-appel et le prochain
 * polling confirmeront les données finales (transcript, durée, prix).
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`voice-call-stop:${user.uid}`, { limit: 20, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de demandes d'arrêt." }, { status: 429 });

    const { id } = await context.params;
    const record = await assertVoiceCallOwner(user.uid, id);
    if (record.completed || ["completed", "failed", "busy", "no-answer", "canceled"].includes(record.status)) {
      return NextResponse.json({ error: "Cet appel est déjà terminé." }, { status: 409 });
    }

    await stopBlandCall(id);
    await adminDb.collection("voiceCalls").doc(id).update({
      status: "canceled",
      completed: true,
      updatedAt: Date.now(),
      lastError: "Arrêté par l'utilisateur Gen3ia.",
    });
    return NextResponse.json({ ok: true, status: "canceled" });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Arrêt impossible."), { status: errorStatus(error) });
  }
}

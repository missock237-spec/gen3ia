import { NextResponse } from "next/server";
import { z } from "zod";

import { appendSecurityAuditEvent } from "@/lib/security/security-audit";
import { captureServerException } from "@/lib/observability/sentry";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import {
  LiveVoiceSessionError,
  liveVoiceErrorStatus,
  verifyLiveVoiceSession,
} from "@/lib/live/voice/session-token";

/**
 * POST /api/live/voice/stop — clôture propre d'une session Live Voix
 * (Task 110-a). Vérification SOUPLE : un jeton déjà expiré est accepté (le
 * client ferme souvent la session APRÈS sa fenêtre de 10 min) ; la signature
 * reste obligatoire. Uniquement un audit : la session étant sans état, il
 * n'y a rien à invalider côté serveur — le client cesse simplement d'émettre.
 */

const StopSchema = z.object({
  token: z.string().min(1).max(8_000),
});

export async function POST(request: Request) {
  try {
    const body = StopSchema.parse(await request.json());
    // Vérification souple : signature obligatoire, expiration tolérée.
    const session = verifyLiveVoiceSession(body.token, { allowExpired: true });
    const durationSec = Math.max(0, Math.round((Date.now() - session.issuedAt) / 1000));
    await appendSecurityAuditEvent({
      userId: session.uid,
      executionId: session.conversationId,
      toolName: "live.voice_session_stopped",
      event: "stopped",
      input: { epoch: session.epoch, durationSec, jti: session.jti },
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof LiveVoiceSessionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: liveVoiceErrorStatus(error.code) });
    }
    captureServerException(error, { route: "live.voice.stop" });
    return NextResponse.json(errorBody(error), { status: errorStatus(error, 400) });
  }
}

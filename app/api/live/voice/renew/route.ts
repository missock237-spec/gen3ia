import { NextResponse } from "next/server";
import { z } from "zod";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { appendSecurityAuditEvent } from "@/lib/security/security-audit";
import { captureServerException } from "@/lib/observability/sentry";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { getWallet } from "@/lib/billing/wallet";
import {
  LIVE_VOICE_MAX_EPOCHS,
  LiveVoiceSessionError,
  liveVoiceErrorStatus,
  signLiveVoiceSession,
  verifyLiveVoiceSession,
} from "@/lib/live/voice/session-token";
import { LIVE_VOICE_MIN_BALANCE_MINOR } from "@/lib/live/voice/cost";
import type { RenewResponse } from "@/lib/live/voice/protocol";

/**
 * POST /api/live/voice/renew — renouvellement d'une session Live Voix
 * (Task 110-a). Le client appelle à T-30 s avant expiration : l'epoch est
 * incrémenté (plafond LIVE_VOICE_MAX_EPOCHS = 6, soit ~60 min) et un nouveau
 * jeton est émis. Vérification stricte avec grâce 60 s : un jeton expiré
 * depuis plus d'une minute ne peut plus être renouvelé (LIVE_SESSION_EXPIRED).
 */

const RenewSchema = z.object({
  token: z.string().min(1).max(8_000),
});

export async function POST(request: Request) {
  try {
    const auth = await verifyFirebaseAuth(request);
    const body = RenewSchema.parse(await request.json());

    // Grâce stricte (défaut 60 s) : au-delà, la session est expirée.
    const session = verifyLiveVoiceSession(body.token);

    // Le jeton doit appartenir à l'utilisateur authentifié (défense en
    // profondeur : un jeton volé ne vaut pas une session Firebase).
    if (session.uid !== auth.uid) {
      throw new LiveVoiceSessionError(
        "LIVE_SESSION_INVALID",
        "Jeton de session Live Voix émis pour un autre utilisateur.",
      );
    }

    if (session.epoch + 1 > LIVE_VOICE_MAX_EPOCHS) {
      return NextResponse.json(
        { error: "Durée maximale atteinte", code: "LIVE_SESSION_INVALID" },
        { status: 403 },
      );
    }

    // Même garde de solde qu'à la création : une session se prolonge si le
    // portefeuille permet encore des tours facturés.
    const wallet = await getWallet(auth.uid);
    if (wallet.availableMinor < LIVE_VOICE_MIN_BALANCE_MINOR) {
      return NextResponse.json(
        {
          error: "Crédit insuffisant pour poursuivre la session Live Voix. Rechargez votre portefeuille.",
          code: "LIVE_INSUFFICIENT_FUNDS",
        },
        { status: 402 },
      );
    }

    const { token, payload } = signLiveVoiceSession({
      uid: auth.uid,
      conversationId: session.conversationId,
      epoch: session.epoch + 1,
    });
    await appendSecurityAuditEvent({
      userId: auth.uid,
      executionId: session.conversationId,
      toolName: "live.voice_session_renewed",
      event: "started",
      input: { epoch: payload.epoch, previousEpoch: session.epoch, jti: session.jti },
    });

    const response: RenewResponse = {
      token,
      conversationId: session.conversationId,
      expiresAt: payload.exp,
      epoch: payload.epoch,
      maxEpochs: LIVE_VOICE_MAX_EPOCHS,
    };
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof LiveVoiceSessionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: liveVoiceErrorStatus(error.code) });
    }
    captureServerException(error, { route: "live.voice.renew" });
    return NextResponse.json(errorBody(error), { status: errorStatus(error, 400) });
  }
}

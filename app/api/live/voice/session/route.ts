import { NextResponse } from "next/server";
import { z } from "zod";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { appendSecurityAuditEvent } from "@/lib/security/security-audit";
import { captureServerException } from "@/lib/observability/sentry";
import { detectDeviceFromHeaders } from "@/lib/device/detect";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { getWallet } from "@/lib/billing/wallet";
import { createConversation, getConversation } from "@/lib/chat/repository";
import {
  LIVE_VOICE_MAX_EPOCHS,
  LiveVoiceSessionError,
  liveVoiceErrorStatus,
  signLiveVoiceSession,
} from "@/lib/live/voice/session-token";
import { LIVE_VOICE_MIN_BALANCE_MINOR } from "@/lib/live/voice/cost";
import type { CreateSessionResponse } from "@/lib/live/voice/protocol";

/**
 * POST /api/live/voice/session — création d'une session Live Voix (Task 110-a).
 *
 * Pattern de app/api/live/sessions/route.ts : garde PC → auth Firebase →
 * rate limit → validation → audit. La session est un jeton HMAC SANS ÉTAT
 * (epoch 1, durée LIVE_VOICE_SESSION_MS) : aucune écriture de session
 * serveur. Solde insuffisant → 402 code LIVE_INSUFFICIENT_FUNDS.
 */

const PC_ONLY_MESSAGE =
  "La session Live Voix est réservée aux ordinateurs (Windows/Linux/macOS) : elle utilise le micro et la lecture audio du navigateur.";

/** Garde serveur PC-only (même logique que l'agent Live de partage d'écran). */
function pcOnlyGuard(request: Request): NextResponse | null {
  const device = detectDeviceFromHeaders(request.headers);
  if (!device.isLiveCapable) {
    return NextResponse.json(
      { error: PC_ONLY_MESSAGE, code: "LIVE_PC_ONLY", device: device.type, os: device.os },
      { status: 403 },
    );
  }
  return null;
}

const CreateSchema = z.object({
  /** Conversation existante à reprendre ; absente → un fil dédié est créé. */
  conversationId: z.string().trim().min(1).max(256).optional(),
});

/** Titre du fil créé pour une session Live Voix : « Session Live Voix — {date} ». */
function liveVoiceConversationTitle(): string {
  const date = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" }).format(new Date());
  return `Session Live Voix — ${date}`;
}

export async function POST(request: Request) {
  try {
    const pcOnly = pcOnlyGuard(request);
    if (pcOnly) return pcOnly;
    const token = await verifyFirebaseAuth(request);
    const liveLimit = await enforceRateLimit(`live-voice-session:${token.uid}`, { limit: 10, windowMs: 5 * 60 * 1000 });
    if (!liveLimit.allowed) {
      return NextResponse.json(
        { error: "Trop de sessions Live Voix créées rapprochées. Réessayez dans quelques minutes.", code: "LIVE_RATE_LIMITED" },
        { status: 429 },
      );
    }
    const body = CreateSchema.parse(await request.json());

    // Garde de solde AVANT toute écriture : le Live Voix est facturé par tour.
    const wallet = await getWallet(token.uid);
    if (wallet.availableMinor < LIVE_VOICE_MIN_BALANCE_MINOR) {
      return NextResponse.json(
        {
          error: "Crédit insuffisant pour démarrer une session Live Voix. Rechargez votre portefeuille.",
          code: "LIVE_INSUFFICIENT_FUNDS",
        },
        { status: 402 },
      );
    }

    let conversationId = body.conversationId;
    if (conversationId) {
      // Garde d'ownership : la conversation d'un autre utilisateur est
      // indiscernable d'une absente (repository Task 109-b).
      const existing = await getConversation(token.uid, conversationId);
      if (!existing) {
        return NextResponse.json({ error: "Conversation introuvable.", code: "NOT_FOUND" }, { status: 404 });
      }
    } else {
      const created = await createConversation(token.uid, liveVoiceConversationTitle());
      conversationId = created.id;
    }

    const { token: sessionToken, payload } = signLiveVoiceSession({ uid: token.uid, conversationId, epoch: 1 });
    await appendSecurityAuditEvent({
      userId: token.uid,
      executionId: conversationId,
      toolName: "live.voice_session_started",
      event: "started",
      input: { conversationId, epoch: payload.epoch, maxEpochs: LIVE_VOICE_MAX_EPOCHS, jti: payload.jti },
    });

    const response: CreateSessionResponse = {
      token: sessionToken,
      conversationId,
      expiresAt: payload.exp,
      epoch: payload.epoch,
      maxEpochs: LIVE_VOICE_MAX_EPOCHS,
    };
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    if (error instanceof LiveVoiceSessionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: liveVoiceErrorStatus(error.code) });
    }
    captureServerException(error, { route: "live.voice.session" });
    // errorBody gère la ZodError (422 lisible) AVANT toute reconnaissance
    // d'empreinte auth ; errorStatus classe ensuite auth → 401, etc.
    return NextResponse.json(errorBody(error), { status: errorStatus(error, 400) });
  }
}

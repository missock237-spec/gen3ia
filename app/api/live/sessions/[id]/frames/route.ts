import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { rateLimit } from "@/lib/security/rate-limit";
import { captureServerException } from "@/lib/observability/sentry";
import { detectDeviceFromHeaders } from "@/lib/device/detect";
import {
  assertLiveSessionOwner,
  beginLiveAction,
  claimApprovedLiveAction,
  completeLiveAction,
  recordLiveEvent,
  recordLiveObservation,
  recordLiveRuntimeActionResult,
  setPendingLiveAction,
  updateLiveSessionStatus,
} from "@/lib/live/repository";
import { assertActionAllowed, assertFreshLiveTimestamp, validateFrameBase64 } from "@/lib/live/security";
import { actionRequiresConfirmation, decideLiveAction } from "@/lib/live/vision-decider";
import { LiveActionSchema } from "@/lib/live/types";

const PC_ONLY_MESSAGE =
  "L'agent Live est reserve aux ordinateurs (Windows/Linux/macOS) : il utilise le partage d'ecran natif du navigateur.";

const ACTION_RESULT_MAX_AGE_MS = 5 * 60_000;

const FrameSchema = z.object({
  deviceId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/, "deviceId invalide"),
  timestamp: z.number().int().positive(),
  width: z.number().int().min(1).max(10_000),
  height: z.number().int().min(1).max(10_000),
  jpegBase64: z.string().min(1).max(2_000_000),
});

type Params = { params: Promise<{ id: string }> };

function fail(status: number, error: string, code?: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...(code ? { code } : {}), ...(extra ?? {}) }, { status });
}

/**
 * Boucle Live du mode navigateur (aucune gateway, aucun téléchargement).
 *
 * Le navigateur capte l'écran (getDisplayMedia) et pousse chaque frame ici.
 * Le serveur applique exactement la même logique que la gateway WebSocket :
 * validation, décision de vision (LLM), observation tracée, actions auto ou
 * bloquées pour approbation humaine. La réponse indique au navigateur quoi
 * exécuter (action) ou pourquoi il est en pause.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const device = detectDeviceFromHeaders(request.headers);
    if (!device.isLiveCapable) {
      return fail(403, PC_ONLY_MESSAGE, "LIVE_PC_ONLY", { device: device.type, os: device.os });
    }
    const token = await verifyFirebaseAuth(request);
    // Garde-fou coût/abus : une frame déclenche au plus un appel vision.
    const frameLimit = rateLimit(`live-frames:${token.uid}`, { limit: 30, windowMs: 60_000 });
    if (!frameLimit.allowed) {
      return fail(429, "Trop de frames envoyées. Ralentissez l'envoi (une frame toutes les ~3 s suffit).", "LIVE_RATE_LIMITED");
    }

    const { id } = await params;
    const session = await assertLiveSessionOwner(id, token.uid);
    if (session.expiresAt && session.expiresAt <= Date.now()) {
      return fail(410, "Live session expired", "LIVE_EXPIRED");
    }
    if (session.status === "stopped" || session.status === "failed") {
      return fail(409, `Live session is ${session.status}`, `LIVE_${session.status.toUpperCase()}`);
    }
    if (session.inFlightAction) {
      return fail(409, "Une action est encore en cours dont le résultat est inconnu.", "LIVE_ACTION_IN_FLIGHT", {
        inFlightAction: { actionId: session.inFlightAction.actionId, action: session.inFlightAction.action },
      });
    }

    const body = FrameSchema.parse(await request.json());
    if (!session.deviceId) {
      return fail(409, "La session n'a pas encore de client actif : démarrez-la d'abord.", "LIVE_NOT_STARTED");
    }
    if (session.deviceId !== body.deviceId) {
      return fail(401, "Live device is not authorized", "LIVE_DEVICE_MISMATCH");
    }
    assertFreshLiveTimestamp(body.timestamp);
    validateFrameBase64(body.jpegBase64);

    if (session.status === "paused") {
      return fail(409, "Session en pause (action sensible en attente ou pause utilisateur).", "LIVE_PAUSED", {
        pendingAction: session.pendingAction
          ? { actionId: session.pendingAction.actionId, action: session.pendingAction.action, approvedAt: session.pendingAction.approvedAt ?? null }
          : null,
      });
    }

    // 1) Une action sensible a été approuvée par l'utilisateur : la dispatcher
    //    au client navigateur (miroir de dispatchApprovedAction de la gateway),
    //    sans consommer d'appel vision.
    const claim = await claimApprovedLiveAction(id, body.deviceId);
    if (claim) {
      await recordLiveEvent(id, { type: "action.requested", actionId: claim.actionId, action: claim.action, approved: true });
      return NextResponse.json({ decision: null, action: { actionId: claim.actionId, action: claim.action } });
    }

    // 2) Décision de vision sur la frame courante.
    const jpeg = validateFrameBase64(body.jpegBase64);
    const feedback =
      session.runtime?.lastActionResult && Date.now() - session.runtime.lastActionResult.at <= ACTION_RESULT_MAX_AGE_MS
        ? { ...session.runtime.lastActionResult }
        : undefined;
    const decision = await decideLiveAction(session, jpeg, body.width, body.height, feedback);
    const action = decision.action ? LiveActionSchema.parse(decision.action) : undefined;
    const actionId = action ? randomUUID() : undefined;

    await recordLiveObservation(id, {
      deviceId: body.deviceId,
      decisionMessage: decision.message,
      done: decision.done,
      actionId,
    });
    await recordLiveEvent(id, {
      type: "vision.decision",
      message: decision.message,
      done: decision.done,
      action: action ?? null,
    });

    if (decision.done) {
      await updateLiveSessionStatus(id, "connected", body.deviceId);
      await recordLiveEvent(id, { type: "completed", message: decision.message });
      return NextResponse.json({ decision: { done: true, message: decision.message }, paused: true, pauseReason: "Objectif atteint — session en pause." });
    }

    if (!action || !actionId) {
      return NextResponse.json({ decision: { done: false, message: decision.message } });
    }

    assertActionAllowed(action, session.permissions);

    // 3) Action sensible : mise en attente d'approbation humaine (page Live).
    if (actionRequiresConfirmation(action)) {
      await setPendingLiveAction(id, { actionId, action, createdAt: Date.now() });
      await recordLiveEvent(id, { type: "action.blocked", reason: "confirmation_required", actionId, action });
      return NextResponse.json({
        decision: { done: false, message: decision.message },
        pendingApproval: { actionId, action },
        paused: true,
        pauseReason: "Une action sensible requiert votre validation explicite.",
      });
    }

    // 4) Action directe : confiée au navigateur pour exécution + résultat.
    await beginLiveAction(id, actionId, action, body.deviceId);
    await recordLiveEvent(id, { type: "action.requested", actionId, action });
    return NextResponse.json({ decision: { done: false, message: decision.message }, action: { actionId, action } });
  } catch (error) {
    captureServerException(error, { route: "live.sessions.browser.frames" });
    const message = error instanceof Error ? error.message : "Invalid request";
    if (/access denied/i.test(message)) return fail(401, message, "LIVE_DEVICE_MISMATCH");
    if (/authorization|token/i.test(message)) return fail(401, message);
    return fail(400, message);
  }
}

/**
 * Résultat d'exécution d'une action par le navigateur (miroir du message
 * `action.result` de la gateway). Le runtime reprend après enregistrement.
 */
export async function PUT(request: Request, { params }: Params) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    const session = await assertLiveSessionOwner(id, token.uid);
    const ResultSchema = z.object({
      deviceId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
      actionId: z.string().uuid(),
      ok: z.boolean(),
      error: z.string().max(2_000).optional(),
    });
    const body = ResultSchema.parse(await request.json());
    if (session.deviceId && session.deviceId !== body.deviceId) {
      return fail(401, "Live device is not authorized", "LIVE_DEVICE_MISMATCH");
    }
    await completeLiveAction(id, body.actionId, body.deviceId);
    await recordLiveRuntimeActionResult(id, {
      deviceId: body.deviceId,
      actionId: body.actionId,
      ok: body.ok,
      error: body.error,
    });
    await recordLiveEvent(id, { type: "action.result", actionId: body.actionId, ok: body.ok, error: body.error });
    return NextResponse.json({ ok: true });
  } catch (error) {
    captureServerException(error, { route: "live.sessions.browser.actionResult" });
    const message = error instanceof Error ? error.message : "Invalid request";
    const status = /access denied|authorization|token/i.test(message) ? 401 : /Unknown or expired/i.test(message) ? 409 : 400;
    return fail(status, message);
  }
}

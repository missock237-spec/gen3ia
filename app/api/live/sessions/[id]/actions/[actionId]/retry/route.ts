import { NextResponse } from "next/server";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { assertLiveSessionOwner, recoverInFlightLiveAction, recordLiveEvent } from "@/lib/live/repository";

type Params = { params: Promise<{ id: string; actionId: string }> };

/**
 * Explicitly retries an interrupted desktop action.
 *
 * This endpoint intentionally requires a fresh owner authorization because a
 * lost WebSocket result makes the previous action outcome unknowable. Retrying
 * a click/type action can therefore execute it twice; the UI must present that
 * warning before calling this endpoint.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id, actionId } = await params;
    await assertLiveSessionOwner(id, token.uid);
    const pending = await recoverInFlightLiveAction(id, actionId, token.uid);
    await recordLiveEvent(id, {
      type: "action.retry_approved",
      actionId,
      ownerId: token.uid,
      warning: "Previous delivery outcome was unknown; retry may duplicate the action",
    });
    return NextResponse.json({ ok: true, actionId: pending.actionId, status: "running", retryWarning: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to retry live action";
    const status = /access denied|unauthorized|token/i.test(message) ? 401 : /not found/i.test(message) ? 404 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}

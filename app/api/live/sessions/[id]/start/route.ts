import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { captureServerException } from "@/lib/observability/sentry";
import { detectDeviceFromHeaders } from "@/lib/device/detect";
import {
  assertLiveSessionOwner,
  getLiveSession,
  recordLiveEvent,
  startLiveRuntime,
  updateLiveSessionStatus,
} from "@/lib/live/repository";

const StartSchema = z.object({
  deviceId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/, "deviceId invalide"),
});

type Params = { params: Promise<{ id: string }> };

const PC_ONLY_MESSAGE =
  "L'agent Live est reserve aux ordinateurs (Windows/Linux/macOS) : il utilise le partage d'ecran natif du navigateur.";

/**
 * Démarre une session Live depuis le navigateur (mode « browser »).
 *
 * Le navigateur devient le client officiel de la session : il déclare son
 * deviceId, la session passe en « running » et le runtime est initialisé.
 * Aucun téléchargement ni gateway externe : les frames circulent ensuite via
 * POST /api/live/sessions/[id]/frames.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const device = detectDeviceFromHeaders(request.headers);
    if (!device.isLiveCapable) {
      return NextResponse.json(
        { error: PC_ONLY_MESSAGE, code: "LIVE_PC_ONLY", device: device.type, os: device.os },
        { status: 403 },
      );
    }
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    const session = await assertLiveSessionOwner(id, token.uid);
    if (session.expiresAt && session.expiresAt <= Date.now()) {
      return NextResponse.json({ error: "Live session expired" }, { status: 410 });
    }
    if (session.status === "stopped" || session.status === "failed") {
      return NextResponse.json({ error: `Live session is ${session.status}` }, { status: 409 });
    }
    if (session.inFlightAction) {
      return NextResponse.json({ error: "Une action interrompue exige un réessai explicite avant de reprendre." }, { status: 409 });
    }

    const { deviceId } = StartSchema.parse(await request.json());

    await updateLiveSessionStatus(id, "running", deviceId);
    await startLiveRuntime(id, deviceId);
    await recordLiveEvent(id, {
      type: "connected",
      deviceId,
      mode: "browser",
      recoveryRequired: Boolean(session.inFlightAction),
    });

    const updated = await getLiveSession(id);
    return NextResponse.json({ ok: true, deviceId, session: updated ? { id: updated.id, status: updated.status } : null });
  } catch (error) {
    captureServerException(error, { route: "live.sessions.browser.start" });
    const message = error instanceof Error ? error.message : "Invalid request";
    const status = /access denied|authorization|token/i.test(message) ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { rateLimit } from "@/lib/security/rate-limit";
import { appendSecurityAuditEvent } from "@/lib/security/security-audit";
import { captureServerException } from "@/lib/observability/sentry";
import { detectDeviceFromHeaders } from "@/lib/device/detect";
import { createLiveSession, listLiveSessions } from "@/lib/live/repository";
import { createPairingToken, hashPairingToken } from "@/lib/live/security";
import { LivePermissionSchema } from "@/lib/live/types";

const PC_ONLY_MESSAGE =
  "L'agent Live est reserve aux ordinateurs (Windows/Linux/macOS) : il exige la capture d'ecran et le controle clavier/souris.";

/**
 * Garde serveur PC-only : l'agent Live pilote un vrai ordinateur via
 * capture d'ecran + controle clavier/souris. Toute session doit etre creee
 * depuis un desktop (navigateur PC ou app Gen3ia Desktop).
 */
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
  name: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(20_000),
  permissions: z.array(LivePermissionSchema).min(1).max(6),
  ttlMs: z.number().int().min(60_000).max(30 * 24 * 60 * 60 * 1000).default(24 * 60 * 60 * 1000),
});

function unauthorized(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized" }, { status: 401 });
}

export async function POST(request: Request) {
  try {
    const pcOnly = pcOnlyGuard(request);
    if (pcOnly) return pcOnly;
    const token = await verifyFirebaseAuth(request);
    const liveLimit = rateLimit(`live-session:${token.uid}`, { limit: 20, windowMs: 5 * 60 * 1000 });
    if (!liveLimit.allowed) {
      return NextResponse.json({ error: "Trop de sessions creees rapprochees. Reessayez dans quelques minutes." }, { status: 429 });
    }
    const body = CreateSchema.parse(await request.json());
    const pairingToken = createPairingToken();
    const viewerToken = createPairingToken();
    const session = await createLiveSession({
      id: `live_${randomUUID()}`,
      ownerId: token.uid,
      name: body.name,
      objective: body.objective,
      permissions: body.permissions,
      expiresAt: Date.now() + body.ttlMs,
      pairingTokenHash: hashPairingToken(pairingToken),
      viewerTokenHash: hashPairingToken(viewerToken),
    });
    await appendSecurityAuditEvent({
      userId: token.uid,
      executionId: session.id,
      toolName: "live.session_started",
      event: "started",
      input: { name: body.name, permissions: body.permissions, objectiveChars: body.objective.length },
    });
    return NextResponse.json({ session, pairingToken, viewerToken }, { status: 201 });
  } catch (error) {
    captureServerException(error, { route: "live.sessions.create" });
    if (error instanceof Error && /authorization|token|revoked|scheme/i.test(error.message)) return unauthorized(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: 400 });
  }
}

export async function GET(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    const sessions = await listLiveSessions(token.uid);
    return NextResponse.json({ sessions });
  } catch (error) {
    if (error instanceof Error && /authorization|token|revoked|scheme/i.test(error.message)) return unauthorized(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: 400 });
  }
}

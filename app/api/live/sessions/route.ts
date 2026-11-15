import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { appendSecurityAuditEvent } from "@/lib/security/security-audit";
import { captureServerException } from "@/lib/observability/sentry";
import { createLiveSession, listLiveSessions } from "@/lib/live/repository";
import { createPairingToken, hashPairingToken } from "@/lib/live/security";
import { LivePermissionSchema, LiveSessionModeSchema } from "@/lib/live/types";
import { errorStatus } from "@/lib/security/http-errors";

/**
 * ACCÈS PC + ANDROID (réouverture demandée par le propriétaire — l'agent
 * Live est accessible sur ordinateur ET mobile) : l'ancien garde PC-only
 * est RETIRÉ. La session reste authentifiée (Firebase), limitée en débit
 * et cloisonnée propriétaire ; la SOURCE de capture (écran sur PC,
 * caméra sur Android) est choisie par le client — cf.
 * app/live/live-gemini-panel.tsx et docs/live-gemini.md.
 */

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(20_000),
  permissions: z.array(LivePermissionSchema).min(1).max(6),
  ttlMs: z.number().int().min(60_000).max(30 * 24 * 60 * 60 * 1000).default(24 * 60 * 60 * 1000),
  /** "browser" : l'agent est testé directement dans le navigateur (sans téléchargement). */
  mode: LiveSessionModeSchema.default("browser"),
});

function unauthorized(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized" }, { status: 401 });
}

export async function POST(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    const liveLimit = await enforceRateLimit(`live-session:${token.uid}`, { limit: 20, windowMs: 5 * 60 * 1000 });
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
      mode: body.mode,
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
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: errorStatus(error, 400) });
  }
}

export async function GET(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    const sessions = await listLiveSessions(token.uid);
    return NextResponse.json({ sessions });
  } catch (error) {
    if (error instanceof Error && /authorization|token|revoked|scheme/i.test(error.message)) return unauthorized(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: errorStatus(error, 400) });
  }
}

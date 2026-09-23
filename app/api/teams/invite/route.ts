import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { createTeamInvitation, getInvitationByToken, type TeamRole } from "@/lib/teams/repository";

/** GET /api/teams/invite?token=… — lit une invitation par son token. */
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const token = request.nextUrl.searchParams.get("token")?.trim() || "";
    if (!token) {
      return NextResponse.json({ error: "Token manquant", requestId }, { status: 400 });
    }
    const invitation = await getInvitationByToken(token);
    return NextResponse.json({ invitation, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invitation indisponible";
    return NextResponse.json({ error: message, requestId }, { status: message.includes("auth") ? 401 : 404 });
  }
}

/** POST /api/teams/invite — invite un membre par email. */
export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`team-invite:${user.uid}`, { limit: 30, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Limite d'invitations atteinte, reessayez plus tard.", requestId },
        { status: 429, headers: { "x-request-id": requestId } },
      );
    }

    const body = (await request.json().catch(() => null)) as { teamId?: unknown; email?: unknown; role?: unknown } | null;
    const teamId = typeof body?.teamId === "string" ? body.teamId : "";
    const email = typeof body?.email === "string" ? body.email : "";
    const role = typeof body?.role === "string" ? (body.role as TeamRole) : "editor";
    if (!teamId || !email) {
      return NextResponse.json({ error: "teamId et email sont requis", requestId }, { status: 400 });
    }

    const result = await createTeamInvitation(user.uid, { teamId, email, role });
    return NextResponse.json(result, { status: 201, headers: { "x-request-id": requestId } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invitation impossible";
    return NextResponse.json({ error: message, requestId }, { status: 400 });
  }
}

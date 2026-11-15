import { NextRequest, NextResponse } from "next/server";
import { errorStatus } from "@/lib/security/http-errors";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { removeMember, updateMemberRole, type TeamRole } from "@/lib/teams/repository";

/** PATCH /api/teams/[teamId]/members — change le role d'un membre. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { teamId } = await params;
    const body = (await request.json().catch(() => null)) as { memberId?: unknown; role?: unknown } | null;
    const memberId = typeof body?.memberId === "string" ? body.memberId : "";
    const role = typeof body?.role === "string" ? (body.role as TeamRole) : "";
    if (!teamId || !memberId || !role) {
      return NextResponse.json({ error: "teamId, memberId et role sont requis", requestId }, { status: 400 });
    }
    await updateMemberRole(user.uid, teamId, memberId, role);
    return NextResponse.json({ ok: true, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Modification impossible";
    return NextResponse.json({ error: message, requestId }, { status: errorStatus(error, 400) });
  }
}

/** DELETE /api/teams/[teamId]/members — retire un membre (body: { memberId }). */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { teamId } = await params;
    const body = (await request.json().catch(() => null)) as { memberId?: unknown } | null;
    const memberId = typeof body?.memberId === "string" ? body.memberId : "";
    if (!teamId || !memberId) {
      return NextResponse.json({ error: "teamId et memberId sont requis", requestId }, { status: 400 });
    }
    await removeMember(user.uid, teamId, memberId);
    return NextResponse.json({ ok: true, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Suppression impossible";
    return NextResponse.json({ error: message, requestId }, { status: errorStatus(error, 400) });
  }
}

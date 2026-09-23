import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { acceptTeamInvitation } from "@/lib/teams/repository";

/** POST /api/teams/accept — accepte une invitation par token. */
export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`team-accept:${user.uid}`, { limit: 20, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop de tentatives, reessayez plus tard.", requestId },
        { status: 429, headers: { "x-request-id": requestId } },
      );
    }

    const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token) {
      return NextResponse.json({ error: "Token manquant", requestId }, { status: 400 });
    }

    const result = await acceptTeamInvitation(
      { uid: user.uid, email: user.email, name: user.name },
      token,
    );
    return NextResponse.json(result, { headers: { "x-request-id": requestId } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Acceptation impossible";
    return NextResponse.json({ error: message, requestId }, { status: 400 });
  }
}

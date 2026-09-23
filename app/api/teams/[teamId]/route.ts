import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { getTeamWithMembers } from "@/lib/teams/repository";

/** GET /api/teams/[teamId] — details de l'equipe + membres. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { teamId } = await params;
    if (!teamId) {
      return NextResponse.json({ error: "teamId manquant", requestId }, { status: 400 });
    }
    const result = await getTeamWithMembers(teamId, user.uid);
    return NextResponse.json(result, { headers: { "x-request-id": requestId } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Equipe indisponible";
    // Accès refusé (403) d'abord, puis classification typée (401 auth,
    // 503 infra, sinon 404) — insensible à la casse et aux accents.
    const status = /acces\s*refuse|acc[eè]s\s*refus[eé]/i.test(message) ? 403 : errorStatus(error, 404);
    return NextResponse.json(
      { ...errorBody(error, "Equipe indisponible"), requestId },
      { status, headers: { "x-request-id": requestId } },
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { createTeamForUser, listTeamsForUser } from "@/lib/teams/repository";

/** GET /api/teams — liste les equipes de l'utilisateur. */
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const teams = await listTeamsForUser(user.uid);
    return NextResponse.json({ teams, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Liste des equipes indisponible";
    return NextResponse.json(
      { error: message, requestId },
      { status: message.includes("auth") ? 401 : 500 },
    );
  }
}

/** POST /api/teams — cree une equipe. */
export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`team-create:${user.uid}`, { limit: 10, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Limite de creation d'equipes atteinte, reessayez plus tard.", requestId },
        { status: 429, headers: { "x-request-id": requestId } },
      );
    }

    const body = (await request.json().catch(() => null)) as { name?: unknown; description?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name : "";
    const description = typeof body?.description === "string" ? body.description : "";
    if (!name.trim()) {
      return NextResponse.json({ error: "Le nom de l'equipe est requis", requestId }, { status: 400 });
    }

    const team = await createTeamForUser(
      { uid: user.uid, email: user.email, name: user.name },
      { name, description },
    );
    return NextResponse.json({ team, requestId }, { status: 201, headers: { "x-request-id": requestId } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Creation d'equipe impossible";
    return NextResponse.json({ error: message, requestId }, { status: 400 });
  }
}

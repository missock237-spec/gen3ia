import { NextRequest, NextResponse } from "next/server";

import { requireCodeAgentOwner } from "@/lib/agents/code-agent-guard";
import { listTerminalSessions } from "@/lib/agents/runtime/terminal-sessions";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";

/**
 * Sessions du terminal agent — visibles dans le Workshop IDE.
 * Le terminal est réservé aux agents : cette route est en LECTURE
 * (observation des exécutions), jamais en écriture de commandes.
 */
export async function GET(request: NextRequest) {
  try {
    const guard = await requireCodeAgentOwner(request);
    if ("forbidden" in guard) return guard.forbidden;

    const limit = await enforceRateLimit(`dev-terminal-sessions:${guard.user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop de requêtes. Réessayez dans quelques instants." }, { status: 429 });
    }

    const sessions = await listTerminalSessions(guard.user.uid, 30);
    return NextResponse.json({ sessions });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Sessions terminal indisponibles."), { status: errorStatus(error) });
  }
}

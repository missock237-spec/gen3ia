import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireCodeAgentOwner } from "@/lib/agents/code-agent-guard";
import { getTerminalEntries, stopTerminalSession } from "@/lib/agents/runtime/terminal-sessions";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";

const StopSchema = z.object({ action: z.literal("stop") });

/**
 * Entrées d'une session terminal agent.
 *  - GET  : lecture des entrées (paramètre `since` = dernier index connu,
 *           pour le polling temps réel du Workshop IDE) ;
 *  - POST : arrêt de la session par l'utilisateur — les agents ne peuvent
 *           plus y exécuter de nouvelles commandes (l'exécution en cours
 *           reste couverte par l'arrêt d'urgence global).
 * Aucune route n'accepte de commande utilisateur : le terminal est
 * exclusivement alimenté par les agents.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const guard = await requireCodeAgentOwner(request);
    if ("forbidden" in guard) return guard.forbidden;

    const limit = await enforceRateLimit(`dev-terminal-entries:${guard.user.uid}`, { limit: 600, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop de requêtes. Réessayez dans quelques instants." }, { status: 429 });
    }

    const { sessionId } = await params;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      return NextResponse.json({ error: "Identifiant de session invalide." }, { status: 400 });
    }
    const sinceRaw = new URL(request.url).searchParams.get("since");
    const sinceIndex = sinceRaw === null ? -1 : Math.max(-1, Math.min(Number(sinceRaw) || 0, 1_000_000));

    const entries = await getTerminalEntries(guard.user.uid, sessionId, sinceIndex, 300);
    return NextResponse.json({ entries });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Entrées terminal indisponibles."), { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const guard = await requireCodeAgentOwner(request);
    if ("forbidden" in guard) return guard.forbidden;

    const limit = await enforceRateLimit(`dev-terminal-stop:${guard.user.uid}`, { limit: 30, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop de requêtes. Réessayez dans quelques instants." }, { status: 429 });
    }

    const parsed = StopSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: "Action invalide — seule l'action « stop » est permise." }, { status: 400 });
    }

    const { sessionId } = await params;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      return NextResponse.json({ error: "Identifiant de session invalide." }, { status: 400 });
    }

    const stopped = await stopTerminalSession(guard.user.uid, sessionId);
    if (!stopped) {
      return NextResponse.json({ error: "Session introuvable ou déjà arrêtée." }, { status: 404 });
    }
    return NextResponse.json({ success: true, stopped: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Arrêt de session impossible."), { status: errorStatus(error) });
  }
}

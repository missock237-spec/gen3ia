import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { stopWorkspaceTask } from "@/lib/agents/workspace";

/**
 * ARRÊT DÉFINITIF d'une tâche en cours, demandable à tout moment par
 * l'utilisateur (statuts "running" ou "paused" acceptés). La tâche passe à
 * "cancelled" immédiatement et le runtime en cours termine proprement au
 * prochain point de consultation (travail déjà payé conservé).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const limit = await enforceRateLimit(`workspace-stop:${user.uid}`, { limit: 30, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes. Réessayez dans quelques minutes." }, { status: 429 });

    const body = await request.json().catch(() => ({}));
    const reason = typeof body?.reason === "string" ? body.reason : undefined;
    const task = await stopWorkspaceTask(user.uid, id, reason);
    return NextResponse.json({ success: true, task });
  } catch (error) {
    if (error instanceof Error && /Task not found|peut être arrêtée|exécution active/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(errorBody(error, "Arrêt impossible."), { status: errorStatus(error) });
  }
}

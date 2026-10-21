import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

// SYSTÈME AGENT RÉSERVÉ (demande utilisateur n°5).
//
// POST /api/v1/agents/{agentId}/run — « Agent gen appelable par API » — est
// FERMÉ : le système d'agents IA n'est plus actionnable directement par un
// utilisateur (session, clé API entreprise `g3a_` ou chaîne développeur
// `g3x_`). Seule l'IA de Gen3ia active le système agent, À LA DEMANDE d'un
// utilisateur exprimée dans le chat : l'IA décide → chemin interne
// (lib/agents/system-activation.ts, secret serveur AGENTS_SYSTEM_SECRET via
// POST /api/agents/system/activate) → sous-agents créés → ils assistent
// l'agent navigateur.
//
// Le refus est émis AVANT toute authentification : aucune clé n'est vérifiée,
// aucun quota ni journal d'exécution consommé — impossible de contourner par
// une clé valide. Le suivi des missions lancées par le système IA reste
// possible (GET /api/agents/runs/[runId] et son flux SSE, scopés propriétaire).
import { agentSystemReservedBody } from "@/lib/security/agent-system-access";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ agentId: string }>;
}

export async function POST(request: NextRequest, _context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  return NextResponse.json(
    { ...agentSystemReservedBody(), requestId },
    { status: 403, headers: { "x-request-id": requestId } },
  );
}

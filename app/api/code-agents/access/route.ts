import { NextResponse } from "next/server";

import { requireCodeAgentOwner } from "@/lib/agents/code-agent-guard";
import { listAgentsByOwner } from "@/lib/agents/repository";

/** Vérifie l'accès à l'Atelier d'Interfaces (réservé aux agents de code actifs). */
export async function GET(request: Request) {
  const guard = await requireCodeAgentOwner(request);
  if ("forbidden" in guard) {
    const body = (await guard.forbidden.json()) as {
      error?: string;
      code?: string;
    };

    return NextResponse.json(
      {
        access: false,
        reason: body.code ?? "UNAUTHENTICATED",
        message: body.error ?? "Accès refusé",
      },
      {
        status: 200,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }

  const agents = await listAgentsByOwner(guard.user.uid);
  const codeAgents = agents.filter(
    (agent) => agent.type === "code" && agent.status === "active",
  );

  return NextResponse.json(
    {
      access: codeAgents.length > 0,
      codeAgents: codeAgents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        status: agent.status,
      })),
      ...(codeAgents.length === 0
        ? {
            reason: "CODE_AGENT_REQUIRED",
            message:
              "Atelier réservé aux agents de code. Créez et activez un agent de type « code » dans le Studio.",
          }
        : {}),
    },
    {
      headers: { "cache-control": "private, no-store" },
    },
  );
}

import { NextResponse } from "next/server";

import { AuthenticatedUser, requireUser } from "@/lib/security/authenticated-request";
import { countActiveAgentsOfType } from "@/lib/agents/repository";

/**
 * Gate exclusive "Agent de code" : seuls les proprietaires d'au moins un agent
 * actif de type "code" peuvent acceder a l'Atelier d'Interfaces (21st.dev).
 * Renvoie soit { user } soit une reponse 403 prete a retourner.
 */
export async function requireCodeAgentOwner(
  request: Request,
): Promise<{ user: AuthenticatedUser } | { forbidden: NextResponse }> {
  try {
    const user = await requireUser(request as never);
    const count = await countActiveAgentsOfType(user.uid, "code");
    if (count === 0) {
      return {
        forbidden: NextResponse.json(
          {
            error: "Atelier réservé aux agents de code. Créez et activez un agent de type « code » dans le Studio.",
            code: "CODE_AGENT_REQUIRED",
          },
          { status: 403 },
        ),
      };
    }
    return { user };
  } catch (error) {
    return {
      forbidden: NextResponse.json(
        { error: error instanceof Error ? error.message : "Authentification requise", code: "UNAUTHENTICATED" },
        { status: 401 },
      ),
    };
  }
}

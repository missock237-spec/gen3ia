import {
  NextRequest,
  NextResponse,
} from "next/server";

import { z } from "zod";

import {
  enforceRateLimit,
} from "@/lib/security/rate-limit";

// SYSTÈME AGENT RÉSERVÉ (demande n°5) : planification de missions fermée aux
// utilisateurs standard (403 « réservé au système IA ») — admin conservé.
import {
  requireAgentSystemAccess,
} from "@/lib/security/agent-system-access";

import {
  errorBody,
  errorStatus,
} from "@/lib/security/http-errors";

import {
  createAgentPlan,
} from "@/lib/agents/planner/service";

const Schema = z.object({
  objective: z
    .string()
    .min(3)
    .max(20_000),
});

export async function POST(
  request: NextRequest,
) {
  try {
    const user =
      await requireAgentSystemAccess(request);

    // Planification = appel LLM réel (même classe que les routes agent
    // voisines : agent-continue 20/5min) — la route est authentifiée mais
    // n'avait AUCUN quota : un client défaillant pouvait marteler le
    // planificateur.
    const limit =
      await enforceRateLimit(
        `agent-plan:${user.uid}`,
        { limit: 20, windowMs: 5 * 60 * 1000 },
      );

    if (!limit.allowed) {
      return NextResponse.json(
        {
          error:
            "Trop de planifications rapprochées. Reessayez dans quelques minutes.",
        },
        {
          status: 429,
        },
      );
    }

    const body =
      await request.json();

    const parsed =
      Schema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            parsed.error.flatten(),
        },
        {
          status: 400,
        },
      );
    }

    const plan =
      await createAgentPlan(
        user.uid,
        parsed.data.objective,
      );

    return NextResponse.json({
      success: true,
      plan,
    });
  } catch (error) {
    console.error(
      "Agent planner error:",
      error,
    );

    return NextResponse.json(
      errorBody(error, "Planner failed"),
      {
        status: errorStatus(error),
      },
    );
  }
}

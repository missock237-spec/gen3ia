import {
  NextRequest,
  NextResponse,
} from "next/server";

import { z } from "zod";

import {
  requireUser,
} from "@/lib/security/authenticated-request";

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
      await requireUser(request);

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

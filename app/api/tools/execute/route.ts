import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  protectRoute,
} from "@/lib/security/route-guard";

import { enforceRateLimit } from "@/lib/security/rate-limit";

import {
  executeThroughGateway,
} from "@/lib/execution/execution-gateway";

import {
  createAgentPolicy,
} from "@/lib/security/agent-policy";

import {
  executeTool,
} from "@/lib/tools";

import {
  randomUUID,
} from "crypto";

export async function POST(
  request: NextRequest,
) {
  const auth =
    await protectRoute(
      request,
    );

  if (!auth.ok) {
    return auth.response;
  }

  const userId =
    auth.context.userId;

  const limit =
    await enforceRateLimit(
      `tools:${userId}`,
      {
        limit: 30,

        windowMs:
          60 * 1000,
      },
    );

  if (!limit.allowed) {
    // Audit 25-c : le 429 n'exposait pas Retry-After (le délai n'était
    // lisible que dans le corps JSON, ignoré par les clients HTTP et les
    // monitors). L'en-tête est exprimé en secondes entières (au moins 1).
    return NextResponse.json(
      {
        success: false,

        error:
          "Too many tool requests.",

        retryAfterMs:
          limit.retryAfterMs,
      },
      {
        status: 429,

        headers: {
          "retry-after": String(
            Math.max(
              1,

              Math.ceil(
                limit.retryAfterMs / 1000,
              ),
            ),
          ),
        },
      },
    );
  }

  try {
    const body =
      await request.json();

    const {
      toolName,
      input,
      executionId,
    } = body;

    if (
      typeof toolName !==
      "string"
    ) {
      return NextResponse.json(
        {
          success: false,

          error:
            "toolName is required.",
        },
        {
          status: 400,
        },
      );
    }

    const resolvedExecutionId =
      typeof executionId === "string" && executionId
        ? executionId
        : randomUUID();

    const policy =
      createAgentPolicy(
        "standard",
      );

    const result =
      await executeThroughGateway({
        userId,

        executionId: resolvedExecutionId,

        toolName,

        input:
          input ?? {},

        policy,

        execute: async () => {
          const toolResult =
            await executeTool({
              userId,

              executionId: resolvedExecutionId,

              toolName,

              input:
                input ?? {},

              policy,
            });

          if (!toolResult.success) {
            throw new Error(
              toolResult.error ??
                `Tool ${toolName} failed.`,
            );
          }

          return toolResult.output;
        },
      });

    return NextResponse.json(
      {
        success: true,

        result,
      },
      {
        status: 200,
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        success: false,

        error:
          error instanceof Error
            ? error.message
            : "Internal error",
      },
      {
        status:
          error instanceof Error &&
          /permission|policy|denied|not allowed|disabled/i.test(
            error.message,
          )
            ? 403
            : 500,
      },
    );
  }
}

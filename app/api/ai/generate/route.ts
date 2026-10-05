import { errorStatus } from "@/lib/security/http-errors";
import {  NextRequest,
  NextResponse,
} from "next/server";

import {
  requireUser,
} from "@/lib/security/authenticated-request";

import {
  enforceRateLimit,
} from "@/lib/security/rate-limit";

import {
  generate,
} from "@/lib/ai/router";

import {
  z,
} from "zod";

import {
  recordAIUsage,
} from "@/lib/ai/usage"; 

const RequestSchema =
  z.object({
    task: z.enum([
      "chat",
      "reasoning",
      "research",
      "coding",
      "document",
      "automation",
      "agent",
    ]),

    messages: z.array(
      z.object({
        role: z.enum([
          "system",
          "user",
          "assistant",
        ]),

        content:
          z.string().min(1),
      }),
    ),

    provider: z
      .enum([
        "groq",
        "openrouter",
        "anthropic",
        "openai",
        "glm",
      ])
      .optional(),

    model:
      z.string().optional(),

    temperature:
      z.number()
        .min(0)
        .max(2)
        .optional(),

    maxTokens:
      z.number()
        .int()
        .positive()
        .max(100000)
        .optional(),

    preferFree:
      z.boolean().optional(),
  });

export async function POST(
  request: NextRequest,
) {
  try {
    const user =
      await requireUser(request);

    // Coût LLM réel par appel : garde-fou anti-abus (aligné sur /api/ai/image).
    const limit = await enforceRateLimit(`ai-generate:${user.uid}`, { limit: 30, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop de générations rapprochées. Réessayez dans quelques instants." },
        { status: 429, headers: { "retry-after": String(Math.ceil((limit.retryAfterMs ?? 60_000) / 1000)) } },
      );
    }

    const body =
      await request.json();

    const input =
      RequestSchema.parse(body);

    const response =
      await generate({
        ...input,

        metadata: {
          userId: user.uid,
        },
      });

    await recordAIUsage({
      userId: user.uid,
      task: input.task,
      response,
    }).catch(() => undefined);

    return NextResponse.json({
      response,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "AI generation failed.",
      },
      {
        status: errorStatus(error, 400),
      },
    );
  }
}

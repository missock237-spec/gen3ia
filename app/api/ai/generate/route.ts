import { errorStatus } from "@/lib/security/http-errors";
import {  NextRequest,
  NextResponse,
} from "next/server";

import {
  requireUser,
} from "@/lib/security/authenticated-request";

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

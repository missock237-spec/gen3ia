import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  requireUser,
} from "@/lib/security/authenticated-request";

import {
  errorBody,
  errorStatus,
} from "@/lib/security/http-errors";

import {
  SkillFactoryRequestSchema,
} from "@/lib/skills/schema";

import {
  generateSkill,
} from "@/lib/skills/factory";

import {
  createSkill,
} from "@/lib/skills/repository";

import {
  OpenAI,
} from "openai";

function createGenerator() {
  const client =
    new OpenAI({
      apiKey:
        process.env.OPENAI_API_KEY,
    });

  return {
    async generate(prompt: string) {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error(
          "OPENAI_API_KEY is required.",
        );
      }

      const response =
        await client.chat.completions.create({
          model:
            process.env.OPENAI_TEXT_MODEL ||
            "gpt-4.1",

          messages: [
            {
              role: "system",
              content:
                "Return only valid JSON.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],

          response_format: {
            type: "json_object",
          },
        });

      const content =
        response.choices[0]
          ?.message.content;

      if (!content) {
        throw new Error(
          "Skill Factory returned empty output.",
        );
      }

      return JSON.parse(content);
    },
  };
}

export async function POST(
  request: NextRequest,
) {
  try {
    const user =
      await requireUser(request);

    const body =
      await request.json();

    const input =
      SkillFactoryRequestSchema.parse(
        body,
      );

    const skill =
      await generateSkill(
        createGenerator(),
        input,
        user.uid,
      );

    const saved =
      await createSkill(skill);

    return NextResponse.json(
      {
        skill: saved,
      },
      {
        status: 201,
      },
    );
  } catch (error) {
    // errorStatus préserve le 403 CSRF (HttpError de requireUser), le 401
    // d'authentification et le 503 d'infrastructure — seul le reste tombe
    // au repli 400 de la validation d'entrée.
    return NextResponse.json(
      {
        ...errorBody(error, "Skill creation failed."),
      },
      {
        status: errorStatus(error, 400),
      },
    );
  }
}

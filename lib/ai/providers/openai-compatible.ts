import OpenAI from "openai";

import type {
  AIProvider,
  AIRequest,
  AIResponse,
} from "../models";

import {
  getProvider,
} from "../config";

export async function callOpenAICompatible(
  request: AIRequest,
  provider: Extract<
    AIProvider,
    "openai" |
      "groq" |
      "openrouter" |
      "glm" |
      "agnes"
  >,
): Promise<AIResponse> {
  const config =
    getProvider(provider);

  if (!config.apiKey) {
    throw new Error(
      `${provider} API key is missing.`,
    );
  }

  if (!config.baseURL) {
    throw new Error(
      `${provider} base URL is missing.`,
    );
  }

  const client =
    new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });

  const startedAt =
    Date.now();

  const model =
    request.model ||
    config.defaultModel;

  if (
    !model ||
    model === "auto"
  ) {
    throw new Error(
      `${provider} requires a concrete model.`,
    );
  }

  const messages = [
    ...(request.system
      ? [
          {
            role: "system" as const,
            content: request.system,
          },
        ]
      : []),

    ...request.messages.map(
      (message) => ({
        role: message.role,
        content: message.content,
      }),
    ),
  ];

  const response =
    await client.chat.completions.create(
      {
        model,

        messages,

        temperature:
          request.temperature ?? 0.2,

        max_tokens:
          request.maxTokens ?? 8192,

        ...(request.requiresStructuredOutput
          ? { response_format: { type: "json_object" as const } }
          : {}),
      },
      // Fail fast instead of hanging the serverless function: providers must
      // answer within AI_PROVIDER_TIMEOUT_MS (default 55s, under Vercel limits).
      {
        timeout: Number(process.env.AI_PROVIDER_TIMEOUT_MS ?? 55_000),
        maxRetries: 1,
      },
    );

  const choice =
    response.choices[0];

  if (!choice) {
    throw new Error(
      `${provider} returned no choices.`,
    );
  }

  const content =
    choice.message.content;

  if (typeof content !== "string") {
    throw new Error(
      `${provider} returned unsupported content.`,
    );
  }

  const usage =
    response.usage;

  return {
    id: response.id,

    provider,

    model:

      response.model || model,

    text: content,

    usage: {
      inputTokens:
        usage?.prompt_tokens ?? 0,

      outputTokens:
        usage?.completion_tokens ?? 0,

      totalTokens:
        usage?.total_tokens ?? 0,
    },

    finishReason:
      choice.finish_reason ??
      undefined,

    raw: response,

    latencyMs:
      Date.now() - startedAt,
  };
}

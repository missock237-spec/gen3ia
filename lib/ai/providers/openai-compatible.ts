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

/**
 * Variante en flux (streaming) : les tokens sont transmis à `onDelta` au fil
 * de leur arrivée, et une réponse complète (mêmes métadonnées que
 * `callOpenAICompatible`) est retournée à la fin. Utilisée par le moteur
 * conversationnel pour écrire la réponse en direct dans le fil.
 */
export async function callOpenAICompatibleStream(
  request: AIRequest,
  provider: Extract<
    AIProvider,
    "openai" |
      "groq" |
      "openrouter" |
      "glm" |
      "agnes"
  >,
  onDelta: (delta: string) => void | Promise<void>,
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

  const stream =
    await client.chat.completions.create(
      {
        model,

        messages,

        stream: true,

        stream_options: { include_usage: true },

        temperature:
          request.temperature ?? 0.2,

        max_tokens:
          request.maxTokens ?? 8192,
      },
      {
        timeout: Number(process.env.AI_PROVIDER_TIMEOUT_MS ?? 55_000),
        maxRetries: 1,
      },
    );

  let content = "";
  let finishReason: string | undefined;
  let completionId = "";
  let responseModel = model;
  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;

  for await (const chunk of stream) {
    if (chunk.id) completionId = chunk.id;
    if (chunk.model) responseModel = chunk.model;
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) {
      content += delta;
      await onDelta(delta);
    }
    if (chunk.usage) usage = chunk.usage;
  }

  if (content.length === 0) {
    throw new Error(
      `${provider} stream returned no content.`,
    );
  }

  return {
    id: completionId,

    provider,

    model: responseModel,

    text: content,

    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,

      // Comptage absent du dernier chunk : estimation honnête (~4 car./token)
      // plutôt que 0 — la facturation interne reste prudente.
      outputTokens:
        usage?.completion_tokens ?? Math.ceil(content.length / 4),

      totalTokens:
        usage?.total_tokens
          ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? Math.ceil(content.length / 4)),
    },

    finishReason: finishReason,

    latencyMs:
      Date.now() - startedAt,
  };
}

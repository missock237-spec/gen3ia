import type {
  AIRequest,
  AIResponse,
} from "../models";
import type { AIMessage } from "../models";

import { clampOutputTokens } from "../context-window";

import {
  getProvider,
} from "../config";

interface AnthropicResponse {
  id: string;

  model: string;

  content: Array<{
    type: string;
    text?: string;
  }>;

  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };

  stop_reason?: string;
}

/**
 * Contenu de message Anthropic : texte simple, ou parts multiples quand le
 * message porte des images (vision, Task 42 axe 4). Les images base64 sont
 * envoyées en source base64 ; les URLs en source url (support natif).
 * Une data URI transmise dans une source url (appelant direct) est convertie
 * en base64 : l'API Anthropic n'accepte que http(s) en source url.
 */
const DATA_URI_IMAGE_RE = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i;

function toAnthropicContent(message: AIMessage): string | Array<Record<string, unknown>> {
  const images = message.images ?? [];
  if (images.length === 0) return message.content;
  const parts: Array<Record<string, unknown>> = [];
  if (message.content.trim()) {
    parts.push({ type: "text", text: message.content });
  }
  for (const image of images) {
    if (image.source.type === "base64") {
      parts.push({
        type: "image",
        source: { type: "base64", media_type: image.mediaType, data: image.source.data },
      });
      continue;
    }
    const url = image.source.url.trim();
    const dataUri = DATA_URI_IMAGE_RE.exec(url);
    if (dataUri) {
      parts.push({
        type: "image",
        source: { type: "base64", media_type: dataUri[1], data: dataUri[2] },
      });
      continue;
    }
    parts.push({
      type: "image",
      source: { type: "url", url },
    });
  }
  return parts;
}

export async function callAnthropic(
  request: AIRequest,
): Promise<AIResponse> {
  const config =
    getProvider("anthropic");

  if (!config.apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is missing.",
    );
  }

  if (
    !config.defaultModel ||
    config.defaultModel === "auto"
  ) {
    throw new Error(
      "CLAUDE_MODEL must be configured.",
    );
  }

  const startedAt =
    Date.now();

  // Garde de résilience (Task 45) : sans timeout, un hang d'Anthropic
  // bloque l'appel jusqu'au kill serverless — même contrat que le provider
  // OpenAI-compatible (55 s).
  const TIMEOUT_MS = 55_000;

  const response =
    await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json",

          "x-api-key":
            config.apiKey,

          "anthropic-version":
            "2023-06-01",
        },

        signal: AbortSignal.timeout(TIMEOUT_MS),

        body: JSON.stringify({
          model:
            request.model ||
            config.defaultModel,

          max_tokens:
            clampOutputTokens(request.model || config.defaultModel, request.maxTokens),

          system:
            request.system,

          messages:
            request.messages
              .filter(
                (message) =>
                  message.role !==
                  "system",
              )
              .map(
                (message) => ({
                  role:
                    message.role ===
                    "assistant"
                      ? "assistant"
                      : "user",

                  content:
                    toAnthropicContent(message),
                }),
              ),
        }),
      },
    );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Anthropic error ${response.status}: ${errorText}`,
    );
  }

  const data =
    (await response.json()) as AnthropicResponse;

  const text =
    data.content
      .filter(
        (item) =>
          item.type === "text",
      )
      .map(
        (item) =>
          item.text ?? "",
      )
      .join("");

  return {
    id: data.id,

    provider: "anthropic",

    model: data.model,

    text,

    usage: {
      inputTokens:
        data.usage?.input_tokens ??
        0,

      outputTokens:
        data.usage?.output_tokens ??
        0,

      totalTokens:
        (data.usage?.input_tokens ??
          0) +
        (data.usage?.output_tokens ??
          0),
    },

    finishReason:
      data.stop_reason,

    raw: data,

    latencyMs:
      Date.now() - startedAt,
  };
}

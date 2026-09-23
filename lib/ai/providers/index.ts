import type {
  AIProvider,
  AIRequest,
  AIResponse,
} from "../models";

import {
  callOpenAICompatible,
  callOpenAICompatibleStream,
} from "./openai-compatible";

import {
  callAnthropic,
} from "./anthropic";

export async function callProvider(
  provider: AIProvider,
  request: AIRequest,
): Promise<AIResponse> {
  switch (provider) {
    case "openai":
    case "groq":
    case "openrouter":
    case "glm":
    case "agnes":
      return callOpenAICompatible(
        request,
        provider,
      );

    case "anthropic":
      return callAnthropic(
        request,
      );

    case "huggingface":
      throw new Error(
        "Hugging Face text provider adapter is implemented separately.",
      );

    default:
      throw new Error(
        `Unsupported provider: ${provider}`,
      );
  }
}

/**
 * Variante en flux : délègue aux fournisseurs compatibles OpenAI (les seuls
 * configurés avec le streaming actif). Anthropic bascule sur la réponse
 * complète (pas de dégradation de service : le texte est transmis en un
 * seul delta). La signature reste identique à `callProvider`.
 */
export async function callProviderStream(
  provider: AIProvider,
  request: AIRequest,
  onDelta: (delta: string) => void | Promise<void>,
): Promise<AIResponse> {
  switch (provider) {
    case "openai":
    case "groq":
    case "openrouter":
    case "glm":
    case "agnes":
      return callOpenAICompatibleStream(
        request,
        provider,
        onDelta,
      );

    case "anthropic": {
      const response = await callAnthropic(request);
      await onDelta(response.text);
      return response;
    }

    default:
      throw new Error(
        `Unsupported streaming provider: ${provider}`,
      );
  }
}

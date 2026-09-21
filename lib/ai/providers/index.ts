import type {
  AIProvider,
  AIRequest,
  AIResponse,
} from "../models";

import {
  callOpenAICompatible,
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

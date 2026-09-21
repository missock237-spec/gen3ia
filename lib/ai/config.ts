import type {
  AIProvider,
  ModelCapability,
} from "./models";

export interface ProviderConfig {
  provider: AIProvider;

  enabled: boolean;

  apiKey?: string;

  baseURL?: string;

  defaultModel: string;

  priority: number;
}

export const PROVIDERS:
  ProviderConfig[] = [
    {
      provider: "groq",

      enabled:
        Boolean(process.env.GROQ_API_KEY),

      apiKey:
        process.env.GROQ_API_KEY,

      baseURL:
        "https://api.groq.com/openai/v1",

      defaultModel:
        process.env.GROQ_MODEL ||
        "openai/gpt-oss-120b",

      priority: 90,
    },

    {
      provider: "openrouter",

      enabled:
        Boolean(
          process.env.OPENROUTER_API_KEY,
        ),

      apiKey:
        process.env.OPENROUTER_API_KEY,

      baseURL:
        "https://openrouter.ai/api/v1",

      defaultModel:
        process.env.OPENROUTER_MODEL ||
        "openrouter/free",

      priority: 80,
    },

    {
      provider: "openai",

      enabled:
        Boolean(process.env.OPENAI_API_KEY),

      apiKey:
        process.env.OPENAI_API_KEY,

      baseURL:
        "https://api.openai.com/v1",

      defaultModel:
        process.env.OPENAI_TEXT_MODEL ||
        "auto",

      priority: 100,
    },

    {
      provider: "anthropic",

      enabled:
        Boolean(
          process.env.ANTHROPIC_API_KEY,
        ),

      apiKey:
        process.env.ANTHROPIC_API_KEY,

      defaultModel:
        process.env.CLAUDE_MODEL ||
        "auto",

      priority: 98,
    },

    {
      provider: "glm",

      enabled:
        Boolean(process.env.GLM_API_KEY),

      apiKey:
        process.env.GLM_API_KEY,

      baseURL:
        process.env.GLM_BASE_URL,

      defaultModel:
        process.env.GLM_MODEL ||
        "auto",

      priority: 95,
    },

    {
      provider: "agnes",

      enabled:
        Boolean(process.env.AGNES_API_KEY),

      apiKey:
        process.env.AGNES_API_KEY,

      baseURL:
        "https://apihub.agnes-ai.com/v1",

      defaultModel:
        process.env.AGNES_TEXT_MODEL ||
        "agnes-3.0-flash",

      priority: 85,
    },
  ];

export function getProvider(
  provider: AIProvider,
): ProviderConfig {
  const config =
    PROVIDERS.find(
      (item) =>
        item.provider === provider,
    );

  if (!config) {
    throw new Error(
      `Unknown AI provider: ${provider}`,
    );
  }

  if (!config.enabled) {
    throw new Error(
      `${provider} is not configured.`,
    );
  }

  return config;
}

export const MODEL_CAPABILITIES:
  ModelCapability[] = [
    {
      provider: "groq",

      model:
        process.env.GROQ_MODEL ||
        "openai/gpt-oss-120b",

      tasks: [
        "chat",
        "reasoning",
        "coding",
        "research",
        "agent",
      ],

      toolCalling: true,
      vision: true,
      structuredOutput: true,
      streaming: true,

      priority: 90,
    },

    {
      provider: "openrouter",

      model:
        process.env.OPENROUTER_MODEL ||
        "openrouter/free",

      tasks: [
        "chat",
        "reasoning",
        "coding",
        "research",
        "agent",
      ],

      toolCalling: true,
      vision: true,
      structuredOutput: true,
      streaming: true,

      priority: 80,
    },

    {
      provider: "openai",

      model:
        process.env.OPENAI_TEXT_MODEL ||
        "auto",

      tasks: [
        "chat",
        "reasoning",
        "coding",
        "research",
        "agent",
      ],

      toolCalling: true,
      vision: true,
      structuredOutput: true,
      streaming: true,

      priority: 100,
    },

    {
      provider: "anthropic",

      model:
        process.env.CLAUDE_MODEL ||
        "auto",

      tasks: [
        "chat",
        "reasoning",
        "coding",
        "research",
        "agent",
      ],

      toolCalling: true,
      vision: true,
      structuredOutput: true,
      streaming: true,

      priority: 98,
    },

    {
      provider: "glm",

      model:
        process.env.GLM_MODEL ||
        "auto",

      tasks: [
        "chat",
        "reasoning",
        "coding",
        "research",
        "agent",
      ],

      toolCalling: true,
      vision: true,
      structuredOutput: true,
      streaming: true,

      priority: 95,
    },

    {
      provider: "agnes",

      model:
        process.env.AGNES_TEXT_MODEL ||
        "agnes-3.0-flash",

      tasks: [
        "chat",
        "reasoning",
        "agent",
      ],

      toolCalling: true,
      vision: true,
      structuredOutput: true,
      streaming: true,

      priority: 85,
    },
  ];

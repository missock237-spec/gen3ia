export type AIProvider =
  | "groq"
  | "openrouter"
  | "anthropic"
  | "openai"
  | "glm"
  | "agnes"
  | "huggingface";

export type TaskType =
  | "chat"
  | "reasoning"
  | "research"
  | "coding"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "automation"
  | "agent";

export type AIMessageRole =
  | "system"
  | "user"
  | "assistant";

export interface AIMessage {
  role: AIMessageRole;
  content: string;
}

export interface AIRequest {
  task: TaskType;

  messages: AIMessage[];

  model?: string;

  provider?: AIProvider;

  temperature?: number;

  maxTokens?: number;

  requiresTools?: boolean;

  requiresVision?: boolean;

  requiresStructuredOutput?: boolean;

  preferFree?: boolean;

  system?: string;

  metadata?: Record<string, string>;
}

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AIResponse {
  id: string;

  provider: AIProvider;

  model: string;

  text: string;

  usage: AIUsage;

  finishReason?: string;

  raw?: unknown;

  latencyMs: number;
}

export interface ModelCapability {
  provider: AIProvider;

  model: string;

  tasks: TaskType[];

  toolCalling: boolean;

  vision: boolean;

  structuredOutput: boolean;

  streaming: boolean;

  priority: number;
}

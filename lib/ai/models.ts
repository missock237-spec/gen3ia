/**
 * CONTRAT IA DU PROJET — moteur unique : le SYSTÈME NEURONAL Gen3
 * (lib/neural/, SNN à spikes, portage du système de l'utilisateur).
 *
 * Les fournisseurs LLM externes (OpenAI, Anthropic, Groq, OpenRouter,
 * GLM, Agnes) ont été SUPPRIMÉS du projet sur demande explicite de
 * l'utilisateur : seules des IA externes devaient disparaître, tout le
 * reste de la structure reste intact. « gen3-snn » est le seul
 * fournisseur restant — le moteur interne, servi par le routeur
 * (lib/ai/router.ts) via lib/neural/runtime.ts.
 */
export type AIProvider = "gen3-snn";

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

export interface AIImageAttachment {
  /** Type MIME validé par lib/ai/content-filter.ts. */
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";

  /** Soit des octets encodés base64 (sans préfixe data:), soit une URL. */
  source:
    | { type: "base64"; data: string }
    | { type: "url"; url: string };
}

export interface AIMessage {
  role: AIMessageRole;
  content: string;

  /**
   * Pièces jointes image : validées par lib/ai/content-filter.ts (nombre,
   * taille, format). Le moteur neuronal ne possède pas de capacité vision —
   * les images jointes sont conservées comme pièces jointes (artefacts)
   * sans être interprétées ; aucune transcription fabriquée.
   */
  images?: AIImageAttachment[];
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

  /**
   * Fragments de la BASE DE CONNAISSANCES réellement recherchés pour ce
   * tour (lib/knowledge/chat-context — score >= 0.3). Consommé par le
   * moteur neural local (pont connaissances -> réponse) pour que les
   * documents ingérés par l'utilisateur atteignent le TEXTE de la réponse,
   * pas seulement le system prompt (qui n'influence que l'encodage).
   */
  knowledgeContext?: string;

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

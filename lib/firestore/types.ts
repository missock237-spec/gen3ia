import {
  Timestamp,
  FieldValue
} from "@/lib/r2fs";

export type TimestampValue =
  | Timestamp
  | FieldValue;

export interface Project {
  id: string;
  ownerId: string;

  name: string;
  description: string;

  visibility:
    | "private"
    | "unlisted"
    | "public";

  status:
    | "active"
    | "archived"
    | "deleted";

  createdAt: TimestampValue;
  updatedAt: TimestampValue;
}

export interface Agent {
  id: string;
  projectId: string;
  ownerId: string;

  name: string;
  description: string;

  systemPrompt: string;

  modelStrategy:
    | "automatic"
    | "fixed";

  preferredProvider?: string;
  preferredModel?: string;

  autonomous: boolean;

  maxIterations: number;

  skills: string[];

  tools: string[];

  memoryEnabled: boolean;

  webResearchEnabled: boolean;

  documentGenerationEnabled: boolean;

  status:
    | "draft"
    | "active"
    | "paused"
    | "archived";

  createdAt: TimestampValue;
  updatedAt: TimestampValue;
}

export interface Execution {
  id: string;

  projectId: string;
  agentId: string;
  userId: string;

  task: string;

  status:
    | "queued"
    | "planning"
    | "running"
    | "evaluating"
    | "completed"
    | "failed"
    | "cancelled";

  iteration: number;

  maxIterations: number;

  selectedSkills: string[];

  selectedTools: string[];

  selectedProvider?: string;
  selectedModel?: string;

  result?: unknown;

  error?: string;

  startedAt?: TimestampValue;
  completedAt?: TimestampValue;

  createdAt: TimestampValue;
  updatedAt: TimestampValue;
}

export interface Skill {
  id: string;

  ownerId?: string;

  name: string;
  description: string;

  version: string;

  systemInstructions: string;

  capabilities: string[];

  triggers: string[];

  requiredTools: string[];

  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;

  qualityCriteria: string[];

  autonomousCreationAllowed: boolean;

  visibility:
    | "system"
    | "private"
    | "public";

  enabled: boolean;

  createdAt: TimestampValue;
  updatedAt: TimestampValue;
}

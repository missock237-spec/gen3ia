import type {
  Agent
} from "@/lib/firestore/types";

export interface CreateAgentInput {
  id: string;
  projectId: string;
  ownerId: string;

  name: string;
  description: string;

  systemPrompt: string;

  autonomous?: boolean;

  maxIterations?: number;

  skills?: string[];

  tools?: string[];
}

export function createAgent(
  input: CreateAgentInput
): Agent {
  const now =
    new Date().toISOString();

  return {
    id: input.id,

    projectId:
      input.projectId,

    ownerId:
      input.ownerId,

    name:
      input.name,

    description:
      input.description,

    systemPrompt:
      input.systemPrompt,

    modelStrategy:
      "automatic",

    autonomous:
      input.autonomous ?? true,

    maxIterations:
      input.maxIterations ?? 8,

    skills:
      input.skills ?? [],

    tools:
      input.tools ?? [],

    memoryEnabled: true,

    webResearchEnabled: true,

    documentGenerationEnabled: true,

    status: "draft",

    createdAt: now as never,
    updatedAt: now as never
  };
}

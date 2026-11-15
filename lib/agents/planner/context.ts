import {
  toolRegistry,
} from "@/lib/tools";

export interface PlannerContext {
  userId: string;

  objective: string;

  availableTools: Array<{
    name: string;
    description: string;
    risk: string;
  }>;

  availableSkills: Array<{
    id: string;
    name: string;
    description: string;
    capabilities: string[];
  }>;
}

export function buildPlannerToolContext() {
  return toolRegistry
    .list()
    .map((tool) => ({
      name: tool.name,
      description:
        tool.description,
      risk: tool.risk,
    }));
}

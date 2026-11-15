export interface SkillDefinition {
  id: string;
  name: string;
  version: string;

  description: string;

  triggers: string[];

  capabilities: string[];

  requiredTools: string[];

  instructions: string;

  inputSchema: Record<string, unknown>;

  outputSchema: Record<string, unknown>;

  qualityCriteria: string[];

  maxIterations: number;

  enabled: boolean;

  createdAt: string;

  updatedAt: string;
}

export interface SkillSelection {
  skillId: string;
  relevance: number;
  reason: string;
}

export interface SkillExecution {
  skillId: string;
  input: unknown;
  output: unknown;
  score: number;
  iterations: number;
  errors: string[];
}

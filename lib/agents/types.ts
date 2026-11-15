import type { TaskType } from "@/lib/ai/models";

export type AgentExecutionStatus =
  | "queued"
  | "planning"
  | "executing"
  | "evaluating"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface AgentTask {
  id: string;

  userId: string;
  projectId: string;
  agentId: string;

  objective: string;

  taskType: TaskType;

  context?: string;

  constraints?: string[];

  requestedOutput?: string;

  autonomous: boolean;

  maxIterations: number;

  createdAt: string;
}

export interface AgentPlanStep {
  id: string;

  order: number;

  title: string;

  objective: string;

  taskType: TaskType;

  requiredSkills: string[];

  requiredTools: string[];

  dependencies: string[];

  status: AgentStepStatus;

  result?: unknown;

  error?: string;
}

export interface AgentPlan {
  taskId: string;

  objective: string;

  steps: AgentPlanStep[];

  reasoningSummary: string;

  createdAt: string;
}

export interface AgentObservation {
  stepId: string;

  success: boolean;

  output?: unknown;

  error?: string;

  metadata?: Record<string, unknown>;

  timestamp: string;
}

export interface EvaluationResult {
  score: number;

  passed: boolean;

  criteria: Array<{
    name: string;
    score: number;
    feedback: string;
  }>;

  missingRequirements: string[];

  suggestedCorrections: string[];

  evaluatedAt: string;
}

export interface AgentExecutionState {
  task: AgentTask;

  plan?: AgentPlan;

  currentStepIndex: number;

  iteration: number;

  observations: AgentObservation[];

  evaluations: EvaluationResult[];

  selectedSkills: string[];

  selectedTools: string[];

  status: AgentExecutionStatus;

  finalResult?: unknown;

  error?: string;
}

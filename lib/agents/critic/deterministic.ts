import {
  RuntimeExecutionState,
} from "@/lib/agents/runtime";

export interface DeterministicCheck {
  passed: boolean;
  score: number;
  issues: string[];
}

export function runDeterministicChecks(
  state: RuntimeExecutionState,
): DeterministicCheck {
  const issues: string[] = [];

  const steps = state.plan.steps;

  if (steps.length === 0) {
    issues.push(
      "Execution contains no steps",
    );
  }

  for (const step of steps) {
    if (
      step.status === "failed"
    ) {
      issues.push(
        `Step ${step.id} failed`,
      );
    }

    if (
      step.status === "pending"
    ) {
      issues.push(
        `Step ${step.id} was never executed`,
      );
    }
  }

  for (const observation of state.observations) {
    if (
      !observation.success &&
      !issues.includes(
        `Step ${observation.stepId} failed`,
      )
    ) {
      issues.push(
        `Step ${observation.stepId} produced an unsuccessful observation`,
      );
    }
  }

  const score =
    issues.length === 0
      ? 1
      : Math.max(
          0,
          1 - issues.length * 0.2,
        );

  return {
    passed:
      issues.length === 0,

    score,

    issues,
  };
}

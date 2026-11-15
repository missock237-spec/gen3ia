import {
  RuntimePlan,
  RuntimeStep,
} from "./types";

export interface DAGValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateDAG(
  plan: RuntimePlan,
): DAGValidationResult {
  const errors: string[] = [];

  const ids = new Set<string>();

  for (const step of plan.steps) {
    if (ids.has(step.id)) {
      errors.push(`Duplicate step ID: ${step.id}`);
    }

    ids.add(step.id);
  }

  for (const step of plan.steps) {
    for (const dependency of step.dependencies) {
      if (!ids.has(dependency)) {
        errors.push(
          `Step ${step.id} depends on unknown step ${dependency}`,
        );
      }

      if (dependency === step.id) {
        errors.push(
          `Step ${step.id} cannot depend on itself`,
        );
      }
    }
  }

  if (errors.length === 0 && hasCycle(plan.steps)) {
    errors.push("DAG contains a dependency cycle");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function hasCycle(steps: RuntimeStep[]): boolean {
  const graph = new Map<string, string[]>();

  for (const step of steps) {
    graph.set(step.id, step.dependencies);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string): boolean {
    if (visiting.has(id)) {
      return true;
    }

    if (visited.has(id)) {
      return false;
    }

    visiting.add(id);

    for (const dependency of graph.get(id) ?? []) {
      if (visit(dependency)) {
        return true;
      }
    }

    visiting.delete(id);
    visited.add(id);

    return false;
  }

  for (const step of steps) {
    if (visit(step.id)) {
      return true;
    }
  }

  return false;
}

export function getReadySteps(
  plan: RuntimePlan,
  completed: Set<string>,
  running: Set<string>,
): RuntimeStep[] {
  return plan.steps.filter((step) => {
    if (step.status !== "pending" && step.status !== "ready") {
      return false;
    }

    if (running.has(step.id)) {
      return false;
    }

    return step.dependencies.every((dependency) =>
      completed.has(dependency),
    );
  });
}

import type {
  Workflow,
} from "./types";

export interface WorkflowValidation {
  valid: boolean;
  errors: string[];
}

export function validateWorkflow(
  workflow: Workflow,
): WorkflowValidation {
  const errors: string[] = [];

  const nodeIds =
    new Set(
      workflow.nodes.map(
        (node) => node.id,
      ),
    );

  for (const edge of workflow.edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push(
        `Unknown source node: ${edge.source}`,
      );
    }

    if (!nodeIds.has(edge.target)) {
      errors.push(
        `Unknown target node: ${edge.target}`,
      );
    }

    if (edge.source === edge.target) {
      errors.push(
        `Self-loop detected: ${edge.source}`,
      );
    }
  }

  const adjacency =
    new Map<string, string[]>();

  for (const node of workflow.nodes) {
    adjacency.set(node.id, []);
  }

  for (const edge of workflow.edges) {
    adjacency
      .get(edge.source)
      ?.push(edge.target);
  }

  const visiting =
    new Set<string>();

  const visited =
    new Set<string>();

  function visit(id: string): void {
    if (visiting.has(id)) {
      errors.push(
        `Workflow cycle detected at node: ${id}`,
      );
      return;
    }

    if (visited.has(id)) {
      return;
    }

    visiting.add(id);

    for (const next of
      adjacency.get(id) ?? []) {
      visit(next);
    }

    visiting.delete(id);
    visited.add(id);
  }

  for (const node of workflow.nodes) {
    visit(node.id);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

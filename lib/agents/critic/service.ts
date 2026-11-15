import {
  RuntimeExecutionState,
} from "@/lib/agents/runtime";

import {
  evaluateExecution,
} from "./engine";

import {
  runDeterministicChecks,
} from "./deterministic";

import {
  CriticResult,
} from "./types";

export async function critiqueExecution(
  state: RuntimeExecutionState,
): Promise<CriticResult> {
  const deterministic =
    runDeterministicChecks(state);

  if (!deterministic.passed) {
    return {
      score:
        deterministic.score,

      passed: false,

      summary:
        "Deterministic execution checks failed.",

      issues:
        deterministic.issues.map(
          (description) => ({
            severity:
              "high" as const,

            category:
              "tool_failure" as const,

            description,

            affectedSteps: [],
          }),
        ),

      corrections: [],

      retry: true,

      retrySteps:
        state.plan.steps
          .filter(
            (step) =>
              step.status ===
              "failed",
          )
          .map(
            (step) => step.id,
          ),
    };
  }

  const aiResult =
    await evaluateExecution({
      objective:
        state.objective,

      stepOutputs:
        state.outputs,

      observations:
        state.observations,
    });

  return aiResult;
}

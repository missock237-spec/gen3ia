import type {
  AgentExecutionState,
  AgentObservation,
  AgentPlanStep
} from "./types";

export interface StepExecutor {
  execute(
    step: AgentPlanStep,
    state: AgentExecutionState
  ): Promise<unknown>;
}

export class AgentExecutor {
  constructor(
    private readonly stepExecutor: StepExecutor
  ) {}

  async execute(
    state: AgentExecutionState
  ): Promise<AgentExecutionState> {
    if (!state.plan) {
      throw new Error(
        "Cannot execute an agent without a plan."
      );
    }

    const nextState: AgentExecutionState = {
      ...state,
      status: "executing" as const
    };

    for (
      let index = state.currentStepIndex;
      index < state.plan.steps.length;
      index++
    ) {
      const step =
        nextState.plan!.steps[index];

      if (
        !this.dependenciesCompleted(
          step,
          nextState
        )
      ) {
        continue;
      }

      step.status = "running";

      try {
        const output =
          await this.stepExecutor.execute(
            step,
            nextState
          );

        step.status = "completed";
        step.result = output;

        const observation:
          AgentObservation = {
            stepId: step.id,
            success: true,
            output,
            timestamp:
              new Date().toISOString()
          };

        nextState.observations.push(
          observation
        );

        nextState.currentStepIndex =
          index + 1;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown execution error.";

        step.status = "failed";
        step.error = message;

        nextState.observations.push({
          stepId: step.id,
          success: false,
          error: message,
          timestamp:
            new Date().toISOString()
        });

        nextState.status = "failed";
        nextState.error = message;

        return nextState;
      }
    }

    nextState.status = "evaluating";

    return nextState;
  }

  private dependenciesCompleted(
    step: AgentPlanStep,
    state: AgentExecutionState
  ): boolean {
    return step.dependencies.every(
      (dependencyId) => {
        const dependency =
          state.plan?.steps.find(
            (candidate) =>
              candidate.id === dependencyId
          );

        return (
          dependency?.status ===
          "completed"
        );
      }
    );
  }
}

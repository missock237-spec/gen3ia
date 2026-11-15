import { RuntimeExecutionState } from "./types";

export interface RuntimeContext {
  userId: string;
  executionId: string;

  state: RuntimeExecutionState;

  variables: Record<string, unknown>;

  signal?: AbortSignal;
}

export function createRuntimeContext(
  userId: string,
  state: RuntimeExecutionState,
  signal?: AbortSignal,
): RuntimeContext {
  return {
    userId,
    executionId: state.executionId,
    state,
    variables: {
      objective: state.objective,
    },
    signal,
  };
}

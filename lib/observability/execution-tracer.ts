import { randomUUID } from "node:crypto";

import { executionLogger } from "./logger";
import { persistExecutionEvent } from "./execution-store";
import { traceExecutionEvent } from "./otel";

export type ExecutionEventType =
  | "execution.started"
  | "execution.completed"
  | "execution.failed"
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "model.request"
  | "model.response"
  | "artifact.created"
  | "sandbox.started"
  | "sandbox.completed";

export interface ExecutionEvent {
  id: string;
  executionId: string;
  type: ExecutionEventType;
  timestamp: string;
  agentId?: string;
  stepId?: string;
  toolName?: string;
  model?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  metadata: Record<string, unknown>;
}

export class ExecutionTracer {
  private readonly events: ExecutionEvent[] = [];
  private readonly log: ReturnType<typeof executionLogger>;

  constructor(
    private readonly executionId: string,
  ) {
    this.log = executionLogger({ executionId: this.executionId });
  }

  emit(
    event: Omit<ExecutionEvent, "id" | "executionId" | "timestamp">,
  ): ExecutionEvent {
    const result: ExecutionEvent = {
      ...event,
      id: randomUUID(),
      executionId: this.executionId,
      timestamp: new Date().toISOString(),
      metadata: event.metadata ?? {},
    };

    this.events.push(result);

    const level = result.type.endsWith(".failed") ? "error" : "info";
    this.log[level]({
      event: result.type,
      eventId: result.id,
      agentId: result.agentId,
      stepId: result.stepId,
      toolName: result.toolName,
      model: result.model,
      durationMs: result.durationMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCostUsd: result.estimatedCostUsd,
      metadata: result.metadata,
    });

    // Telemetry persistence must never break the agent execution itself.
    void persistExecutionEvent(result).catch((error) => {
      this.log.warn({ err: error, eventId: result.id }, "failed to persist execution telemetry");
    });

    // Pont OpenTelemetry (Task 59) : chaque événement devient une span
    // fermée (corrélation gen3ia.execution_id + gen3ia.trace_id depuis le
    // metadata). No-op quand l'export OTLP est désactivé ; fire-and-forget.
    traceExecutionEvent(result);

    return result;
  }

  getEvents(): ExecutionEvent[] {
    return [...this.events];
  }

  getTotalDuration(): number {
    const started = this.events.find((event) => event.type === "execution.started");
    const completed = [...this.events]
      .reverse()
      .find(
        (event) =>
          event.type === "execution.completed" || event.type === "execution.failed",
      );

    if (!started || !completed) return 0;

    return new Date(completed.timestamp).getTime() - new Date(started.timestamp).getTime();
  }

  getEstimatedCost(): number {
    return this.events.reduce(
      (total, event) => total + (event.estimatedCostUsd ?? 0),
      0,
    );
  }
}

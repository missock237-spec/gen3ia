/**
 * Point d'entrée du SDK @gen3ia/sdk.
 *
 * Usage :
 * ```ts
 * import { Gen3iaClient } from "@gen3ia/sdk";
 *
 * const client = new Gen3iaClient({ apiKey: "g3x_…", projectId: "…" });
 * const result = await client.agents.run("agentId", { objective: "…" });
 * ```
 */

export { Gen3iaClient } from "./client.js";
export type {
  Gen3iaClientOptions,
  MissionFollowOptions,
  MissionStreamHandle,
  MissionStreamHandlers,
} from "./client.js";

export {
  Gen3iaApiError,
  Gen3iaConfigurationError,
  Gen3iaError,
  Gen3iaNetworkError,
  Gen3iaTimeoutError,
} from "./errors.js";

export { createSseParser } from "./sse.js";
export type { SseEvent, SseParser } from "./sse.js";

export type {
  AgentIdentity,
  AgentRunResult,
  BillingSummary,
  CommercialChatInput,
  CommercialChatResult,
  CommercialSalonInfo,
  HealthInfo,
  MissionFinalEvent,
  MissionProgressEvent,
  MissionQueued,
  MissionRunResult,
  MissionRunStatus,
  MissionStatus,
  MissionSyncResult,
  MissionTimelineStep,
  PublicAgentChatResult,
  PublicAgentInfo,
  RunMissionInput,
  RuntimePlanInput,
  RuntimeStepInput,
  WebhookTriggerResult,
} from "./types.js";

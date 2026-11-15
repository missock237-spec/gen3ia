import "server-only";

import { runOrchestrator, type AgentRole, type OrchestratorResult } from "@/lib/agents/orchestrator";
import { requireTeamFeatureAccess } from "@/lib/team/feature-access";

export interface TeamCoordinationTask { userId: string; teamId: string; objective: string; context?: Record<string, unknown>; customerId?: string; requestedRoles?: AgentRole[]; signal?: AbortSignal; }
export interface CoordinationResult extends OrchestratorResult { teamId: string; coordination: { mode: "team"; memberRole: string; parallelRoles: AgentRole[]; synthesisRole: "orchestrator" }; }

export async function coordinateTeamExecution(task: TeamCoordinationTask): Promise<CoordinationResult> {
  const access = await requireTeamFeatureAccess({ userId: task.userId, teamId: task.teamId, feature: "orchestrator" });
  const result = await runOrchestrator({
    userId: task.userId,
    objective: task.objective,
    context: { ...(task.context ?? {}), teamId: task.teamId, teamExecution: true, coordinationMode: "team" },
    customerId: task.customerId,
    requestedRoles: task.requestedRoles,
    signal: task.signal,
  });
  return { ...result, teamId: task.teamId, coordination: { mode: "team", memberRole: access.role, parallelRoles: result.roles, synthesisRole: "orchestrator" } };
}

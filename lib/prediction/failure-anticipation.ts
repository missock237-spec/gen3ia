import "server-only";

import { requireTeamFeatureAccess } from "@/lib/team/feature-access";

export type PredictionSeverity = "low" | "medium" | "high" | "critical";
export interface PredictableStep { id: string; name?: string; toolName?: string; type?: string; timeoutMs?: number; maxRetries?: number; sideEffect?: boolean; requiresApproval?: boolean; input?: Record<string, unknown>; }
export interface FailurePrediction { stepId: string; severity: PredictionSeverity; score: number; failureModes: string[]; mitigations: string[]; }
const getSeverity = (score: number): PredictionSeverity => score >= 80 ? "critical" : score >= 55 ? "high" : score >= 30 ? "medium" : "low";

export async function anticipateTeamFailures(input: { userId: string; teamId: string; steps: PredictableStep[] }): Promise<{ teamId: string; predictions: FailurePrediction[]; blocked: boolean }> {
  await requireTeamFeatureAccess({ userId: input.userId, teamId: input.teamId, feature: "prediction" });
  const predictions = input.steps.map((step) => {
    let score = 0; const failureModes: string[] = []; const mitigations: string[] = []; const tool = String(step.toolName ?? "").toLowerCase();
    if ((step.timeoutMs ?? 120000) > 90000) { score += 15; failureModes.push("long-running execution"); mitigations.push("use bounded timeout and cancellation"); }
    if ((step.maxRetries ?? 0) > 2) { score += 10; failureModes.push("retry amplification"); mitigations.push("cap retries and use idempotency"); }
    if (step.sideEffect) { score += 20; failureModes.push("external side effect"); mitigations.push("require approval and verify result"); }
    if (step.requiresApproval) { score += 10; failureModes.push("approval dependency"); mitigations.push("verify persisted approval immediately before execution"); }
    if (/delete|destroy|remove|publish|send|payment|ads|composio/.test(tool)) { score += 25; failureModes.push("high-impact tool"); mitigations.push("apply least privilege, spend limits and audit"); }
    if (/terminal|code|network|web/.test(tool)) { score += 10; failureModes.push("expanded execution surface"); mitigations.push("sandbox and constrain network/tool permissions"); }
    if (step.input && Object.keys(step.input).length > 40) { score += 10; failureModes.push("large input surface"); mitigations.push("validate and cap tool arguments"); }
    return { stepId: step.id, severity: getSeverity(score), score: Math.min(100, score), failureModes: [...new Set(failureModes)], mitigations: [...new Set(mitigations)] };
  });
  return { teamId: input.teamId, predictions, blocked: predictions.some((p) => p.severity === "critical") };
}

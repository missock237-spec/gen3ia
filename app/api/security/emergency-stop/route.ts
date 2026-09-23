import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { appendSecurityAuditEvent } from "@/lib/security/security-audit";
import { activateEmergencyStop, clearEmergencyStop, type StopScope } from "@/lib/security/emergency-stop";

function parseScope(value: unknown): StopScope {
  if (value === undefined) return "user";
  if (value !== "user" && value !== "agent" && value !== "execution") throw new Error("scope must be user, agent, or execution");
  return value;
}

export async function POST(request: Request) {
  try {
    const token = await verifyFirebaseRequest(request);
    const stopLimit = await enforceRateLimit(`emergency-stop:${token.uid}`, { limit: 30, windowMs: 5 * 60 * 1000 });
    if (!stopLimit.allowed) return Response.json({ error: "Trop de tentatives" }, { status: 429 });
    const body = await request.json().catch(() => ({}));
    const scope = parseScope(body.scope);
    await activateEmergencyStop({ userId: token.uid, scope, agentId: typeof body.agentId === "string" ? body.agentId : undefined, executionId: typeof body.executionId === "string" ? body.executionId : undefined, reason: typeof body.reason === "string" ? body.reason : undefined });
    await appendSecurityAuditEvent({
      userId: token.uid,
      executionId: typeof body.executionId === "string" ? body.executionId : `stop_${Date.now()}`,
      toolName: "security.emergency_stop",
      event: "stopped",
      metadata: { scope, agentId: typeof body.agentId === "string" ? body.agentId : "", reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : "" },
    });
    return Response.json({ success: true, stopped: true, scope });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not activate emergency stop";
    const status = message.includes("authorization") || message.includes("token") ? 401 : 400;
    return Response.json({ error: message }, { status });
  }
}

export async function DELETE(request: Request) {
  try {
    const token = await verifyFirebaseRequest(request);
    const stopLimit = await enforceRateLimit(`emergency-stop:${token.uid}`, { limit: 30, windowMs: 5 * 60 * 1000 });
    if (!stopLimit.allowed) return Response.json({ error: "Trop de tentatives" }, { status: 429 });
    const body = await request.json().catch(() => ({}));
    const scope = parseScope(body.scope);
    await clearEmergencyStop({ userId: token.uid, scope, agentId: typeof body.agentId === "string" ? body.agentId : undefined, executionId: typeof body.executionId === "string" ? body.executionId : undefined });
    return Response.json({ success: true, stopped: false, scope });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not clear emergency stop";
    const status = message.includes("authorization") || message.includes("token") ? 401 : 409;
    return Response.json({ error: message }, { status });
  }
}

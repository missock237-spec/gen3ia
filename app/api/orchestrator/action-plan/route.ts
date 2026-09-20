import { randomUUID } from "node:crypto";
import { z } from "zod";
import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { classifyRoles } from "@/lib/agents/orchestrator";
import { planExternalActions } from "@/lib/agents/action-planner";

const BodySchema = z.object({
  objective: z.string().trim().min(1).max(20_000),
  context: z.record(z.string(), z.unknown()).optional(),
  requestedRoles: z.array(z.enum(["customer_service", "sales", "content", "admin", "analytics"])).max(5).optional(),
});

export async function POST(request: Request) {
  try {
    const token = await verifyFirebaseRequest(request);
    const body = BodySchema.parse(await request.json());
    const roles = classifyRoles(body.objective, body.requestedRoles);
    const executionId = randomUUID();
    const actions = await planExternalActions({
      userId: token.uid,
      executionId,
      objective: body.objective,
      roles,
      context: { ...(body.context ?? {}), userId: token.uid },
    });

    return Response.json({
      success: true,
      executionId,
      roles,
      actions,
      requiresConfirmation: actions.length > 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create action plan";
    const status = message.includes("authorization") || message.includes("token") ? 401 : 400;
    return Response.json({ error: message }, { status });
  }
}

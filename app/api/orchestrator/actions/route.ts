import { z } from "zod";
import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { createActionApproval } from "@/lib/agents/action-approvals";
import { roleCanUseExternalActions } from "@/lib/agents/orchestrator-actions";

const BodySchema = z.object({
  executionId: z.string().min(1).max(256),
  role: z.enum(["customer_service", "sales", "content", "admin", "analytics"]),
  toolSlug: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().min(1).max(4000),
});

export async function POST(request: Request) {
  try {
    const token = await verifyFirebaseRequest(request);
    const body = BodySchema.parse(await request.json());

    if (!roleCanUseExternalActions(body.role)) {
      return Response.json({ error: "This agent role cannot request external actions." }, { status: 403 });
    }

    const approval = await createActionApproval({
      ownerId: token.uid,
      executionId: body.executionId,
      role: body.role,
      toolSlug: body.toolSlug,
      arguments: body.arguments,
      reason: body.reason,
    });

    return Response.json({
      success: true,
      approvalId: approval.id,
      status: approval.status,
      executionId: approval.executionId,
      expiresAt: approval.expiresAt,
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create action approval";
    const status = message.includes("authorization") || message.includes("token") ? 401 : 400;
    return Response.json({ error: message }, { status });
  }
}

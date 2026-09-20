import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { claimActionExecution, completeAction, failAction, getActionApproval } from "@/lib/agents/action-approvals";
import { executeToolSecurely } from "@/lib/agents/runtime/secure-tool-executor";
import { buildOrchestratorActionPolicy, roleCanUseExternalActions } from "@/lib/agents/orchestrator-actions";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  let ownerId = "";
  let approvalId = "";
  try {
    const token = await verifyFirebaseRequest(_request);
    ownerId = token.uid;
    const { id } = await context.params;
    approvalId = id;

    const stored = await getActionApproval(ownerId, approvalId);
    if (!roleCanUseExternalActions(stored.role)) {
      return Response.json({ error: "This agent role cannot execute external actions." }, { status: 403 });
    }

    const claimed = await claimActionExecution(ownerId, approvalId);
    const policy = buildOrchestratorActionPolicy({
      roles: [claimed.role],
      allowExternalActions: true,
    });

    const output = await executeToolSecurely({
      userId: ownerId,
      executionId: claimed.executionId,
      toolName: "composio.execute",
      input: {
        toolSlug: claimed.toolSlug,
        arguments: claimed.arguments,
      },
      approvalId,
      policy,
    });

    const completed = await completeAction(ownerId, approvalId, output);
    return Response.json({ success: true, approval: completed, output });
  } catch (error) {
    const message = error instanceof Error ? error.message : "External action failed";
    if (ownerId && approvalId) {
      try {
        const current = await getActionApproval(ownerId, approvalId);
        if (current.status === "executing") await failAction(ownerId, approvalId, message);
      } catch {
        // Preserve the original execution error. The approval remains protected from replay.
      }
    }
    const status = message.includes("authorization") || message.includes("token") ? 401 : message.includes("not found") ? 404 : 409;
    return Response.json({ error: message }, { status });
  }
}

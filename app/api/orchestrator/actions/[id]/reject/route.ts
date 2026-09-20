import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { rejectAction } from "@/lib/agents/action-approvals";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const token = await verifyFirebaseRequest(_request);
    const { id } = await context.params;
    const approval = await rejectAction(token.uid, id);
    return Response.json({ success: true, approval });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not reject action";
    const status = message.includes("authorization") || message.includes("token") ? 401 : message.includes("not found") ? 404 : 409;
    return Response.json({ error: message }, { status });
  }
}

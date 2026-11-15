import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { approveAction } from "@/lib/agents/action-approvals";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const token = await verifyFirebaseRequest(_request);
    const { id } = await context.params;
    const approval = await approveAction(token.uid, id);
    return Response.json({ success: true, approval });
  } catch (error) {
    // Classification canonique : 401 auth, 404 introuvable, repli 409
    // (transition de statut impossible — cas métier principal ici).
    return Response.json(errorBody(error, "Could not approve action"), { status: errorStatus(error, 409) });
  }
}

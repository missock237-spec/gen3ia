import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyRemoteApprovalToken } from "@/lib/integrations/messaging/remote-approval";
import { approveAction, rejectAction, getActionApproval } from "@/lib/agents/action-approvals";

/**
 * Approbation distante depuis WhatsApp / Telegram : aucun cookie requis,
 * uniquement le token HMAC signé contenu dans le lien de notification.
 */

const BodySchema = z.object({
  token: z.string().min(20).max(2048),
  decision: z.enum(["approve", "reject"]),
});

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = BodySchema.parse(await request.json());
    const payload = verifyRemoteApprovalToken(body.token);
    if (!payload) {
      return NextResponse.json({ error: "Lien d'approbation invalide ou expiré." }, { status: 401 });
    }

    // Vérifie que l'approbation existe toujours et appartient au porteur du token.
    const approval = await getActionApproval(payload.ownerId, payload.approvalId);
    if (approval.expiresAt < Date.now()) {
      return NextResponse.json({ error: "Cette approbation a expiré." }, { status: 410 });
    }

    const updated = body.decision === "approve"
      ? await approveAction(payload.ownerId, payload.approvalId)
      : await rejectAction(payload.ownerId, payload.approvalId);

    return NextResponse.json({ success: true, status: updated.status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Approbation distante impossible." }, { status: 400 });
  }
}

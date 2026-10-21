import { NextResponse } from "next/server";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { approvePendingLiveAction, assertLiveSessionOwner, recordLiveEvent } from "@/lib/live/repository";

type Params = { params: Promise<{ id: string; actionId: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id, actionId } = await params;
    await assertLiveSessionOwner(id, token.uid);
    await approvePendingLiveAction(id, actionId, token.uid);
    await recordLiveEvent(id, { type: "action.approved", actionId, ownerId: token.uid });
    return NextResponse.json({ ok: true, actionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to approve live action";
    const status = /access denied|unauthorized|token/i.test(message) ? 401 : /not found/i.test(message) ? 404 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}

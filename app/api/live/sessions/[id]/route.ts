import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { assertLiveSessionOwner, getLiveSession, updateLiveSessionStatus } from "@/lib/live/repository";
import { errorStatus } from "@/lib/security/http-errors";

const ActionSchema = z.object({ action: z.enum(["pause", "resume", "stop"]) });

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    const session = await assertLiveSessionOwner(id, token.uid);
    const { pairingTokenHash: _pairingTokenHash, ...publicSession } = session;
    return NextResponse.json({ session: publicSession });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized";
    return NextResponse.json({ error: message }, { status: /authorization|token|access denied/i.test(message) ? 401 : 404 });
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    await assertLiveSessionOwner(id, token.uid);
    const { action } = ActionSchema.parse(await request.json());
    const status = action === "pause" ? "paused" : action === "resume" ? "running" : "stopped";
    await updateLiveSessionStatus(id, status);
    return NextResponse.json({ ok: true, status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: errorStatus(error, 400) });
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    await assertLiveSessionOwner(id, token.uid);
    await updateLiveSessionStatus(id, "stopped");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized" }, { status: errorStatus(error, 400) });
  }
}

import { NextResponse } from "next/server";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { assertLiveSessionOwner } from "@/lib/live/repository";
import { adminDb } from "@/lib/firebase/admin";
import { errorStatus } from "@/lib/security/http-errors";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    await assertLiveSessionOwner(id, token.uid);
    const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit") || 50), 1), 200);
    const snapshot = await adminDb.collection("liveAgentSessions").doc(id).collection("events").orderBy("createdAt", "desc").limit(limit).get();
    const events = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return NextResponse.json({ events });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to read live events" }, { status: errorStatus(error, 400) });
  }
}

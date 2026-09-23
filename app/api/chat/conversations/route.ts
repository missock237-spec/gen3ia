import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { createConversation, listConversations } from "@/lib/chat/repository";
import { errorStatus } from "@/lib/security/http-errors";

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
    return NextResponse.json({ conversations: await listConversations(user.uid, Number.isFinite(limit) ? limit : 50) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur." }, { status: errorStatus(error, 401) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const body = z.object({ title: z.string().trim().max(120).optional() }).parse(await request.json().catch(() => ({})));
    return NextResponse.json({ conversation: await createConversation(user.uid, body.title) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur." }, { status: errorStatus(error, 400) });
  }
}

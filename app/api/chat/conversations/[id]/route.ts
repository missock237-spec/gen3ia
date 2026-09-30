import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { deleteConversation, getConversation, listMessages, renameConversation } from "@/lib/chat/repository";
import { listRunsForConversation } from "@/lib/domain/runs/repository";
import { errorStatus } from "@/lib/security/http-errors";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request); const { id } = await params;
    const conversation = await getConversation(user.uid, id);
    if (!conversation) return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
    // Runs (timelines de mission) : la réouverture du fil ré-affiche les
    // exécutions passées — plan, étapes et livrables ne disparaissent plus.
    const runs = await listRunsForConversation(user.uid, id, 20).catch(() => []);
    return NextResponse.json({ conversation, messages: await listMessages(user.uid, id), runs });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur." }, { status: errorStatus(error, 400) }); }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request); const { id } = await params;
    const body = z.object({ title: z.string().trim().min(1).max(120) }).parse(await request.json());
    await renameConversation(user.uid, id, body.title);
    return NextResponse.json({ ok: true });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur." }, { status: errorStatus(error, 400) }); }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request); const { id } = await params;
    await deleteConversation(user.uid, id);
    return NextResponse.json({ ok: true });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur." }, { status: errorStatus(error, 400) }); }
}

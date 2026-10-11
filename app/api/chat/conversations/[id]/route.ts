import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { deleteConversation, getConversation, listMessages, renameConversation } from "@/lib/chat/repository";
import { listRunsForConversation } from "@/lib/domain/runs/repository";
import { listArtifacts } from "@/lib/domain/artifacts/repository";
import { errorStatus } from "@/lib/security/http-errors";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request); const { id } = await params;
    const conversation = await getConversation(user.uid, id);
    if (!conversation) return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
    // Lot C2 — sondage léger (?meta=1) : le suivi live du chat agent ne
    // consomme QUE le dernier run (`runs[0]`). Le GET complet scanne aussi
    // tous les messages (~221 lectures/tick) ; ici, conversation + 5 runs
    // récents suffisent (~6 lectures). Enveloppe canonique conservée
    // (conversation + runs) + champ dérivé `lastRunStatus` + `meta: true`.
    if (request.nextUrl.searchParams.get("meta") === "1") {
      const runs = await listRunsForConversation(user.uid, id, 5).catch(() => []);
      return NextResponse.json({ conversation, runs, lastRunStatus: runs[0]?.status ?? null, meta: true });
    }
    // Runs (timelines de mission) : la réouverture du fil ré-affiche les
    // exécutions passées — plan, étapes et livrables ne disparaissent plus.
    // Task 123 — les ARTEFACTS AUDIO de la conversation sont renvoyés aussi :
    // le lecteur intégré du chat agent les résout depuis la clé R2 permanente
    // (livraison directe, survit au refresh). Task 124 — messages + runs +
    // artefacts agrégés en un seul Promise.all (trois lectures indépendantes,
    // au lieu de trois allers-retours séquentiels).
    const [messages, runs, audioArtifacts] = await Promise.all([
      listMessages(user.uid, id),
      listRunsForConversation(user.uid, id, 20).catch(() => []),
      listArtifacts(user.uid, { conversationId: id, type: "audio", limit: 50 }).catch(() => []),
    ]);
    return NextResponse.json({
      conversation,
      messages,
      runs,
      ...(audioArtifacts.length > 0 ? { artifacts: audioArtifacts } : {}),
    });
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

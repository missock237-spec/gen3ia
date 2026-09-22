import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { createRecord, listRecords, deleteRecord, unfoldRecord } from "@/lib/engines/data-engine";
import { runAIJSON } from "@/lib/engines/ai-engine";
import { createEvent } from "@/lib/engines/scheduling-engine";
import { emitBusinessEvent } from "@/lib/engines/events";
import { listPhoneCallSessions } from "@/lib/integrations/twilio/calls";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Module Sales — Call Intelligence.
 * S'appuie sur la Call App évoluée (Task 14) : chaque appel téléphonique
 * terminé peut être analysé par l'AI Engine — résumé, sentiment, objections,
 * prochaines actions, score d'opportunité — puis un rendez-vous de suivi est
 * automatiquement planifié via le Scheduling Engine.
 */

const COLLECTION = "salesCallInsights";

const InsightSchema = z.object({
  summary: z.string().min(30).max(2_000),
  sentiment: z.enum(["positif", "neutre", "negatif"]),
  interestLevel: z.enum(["chaud", "tiede", "froid"]),
  score: z.number().int().min(0).max(100),
  objections: z.array(z.object({ objection: z.string().max(300), response: z.string().max(500) })).max(8),
  nextSteps: z.array(z.string().min(3).max(300)).min(1).max(8),
  followUpDays: z.number().int().min(0).max(90),
  followUpReason: z.string().max(300),
});
export type CallInsight = z.infer<typeof InsightSchema>;

const PostSchema = z.object({
  action: z.literal("analyze").default("analyze"),
  callSessionId: z.string().min(1).max(160),
});

function transcriptOf(history: Array<{ role: string; text: string }>): string {
  return history.map((turn) => `${turn.role === "assistant" ? "AGENT" : "CLIENT"} : ${turn.text}`).join("\n").slice(0, 30_000);
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await rateLimitDistributed(`business:callintel:${user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes, réessayez dans un instant." }, { status: 429 });

    const records = await listRecords({ userId: user.uid, collection: COLLECTION, orderBy: { field: "createdAt", direction: "desc" }, limit: 50 });
    // Appels téléphoniques éligibles : terminés, avec un historique exploitable.
    const sessions = await listPhoneCallSessions(user.uid, undefined, 30);
    const analyzed = new Set(records.map((r) => (r.data as { callSessionId?: string }).callSessionId));
    const available = sessions
      .filter((s) => s.status === "completed" && s.history.length > 0 && !analyzed.has(s.id))
      .map((s) => ({
        id: s.id,
        to: s.to,
        objective: s.objective,
        status: s.status,
        turns: s.history.length,
        createdAt: s.createdAt,
      }));
    return NextResponse.json({ insights: records.map(unfoldRecord), availableCalls: available });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Intelligence d'appels indisponible."), { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = PostSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Requête invalide.", details: parsed.error.flatten().fieldErrors }, { status: 400 });

    const sessions = await listPhoneCallSessions(user.uid, undefined, 50);
    const session = sessions.find((s) => s.id === parsed.data.callSessionId);
    if (!session || session.userId !== user.uid) return NextResponse.json({ error: "Appel introuvable." }, { status: 404 });
    if (session.history.length === 0) return NextResponse.json({ error: "Cet appel n'a aucune transcription à analyser." }, { status: 400 });

    const result = await runAIJSON({
      userId: user.uid,
      feature: "sales-call-intelligence",
      system:
        "Tu es un directeur commercial senior qui audite des appels de vente. Tu es factuel : tout ce que tu affirmes vient de la transcription. " +
        'Réponds UNIQUEMENT en JSON: {"summary": string, "sentiment": "positif"|"neutre"|"negatif", "interestLevel": "chaud"|"tiede"|"froid", "score": number(0-100), "objections": [{"objection": string, "response": string}], "nextSteps": string[], "followUpDays": number, "followUpReason": string}. ' +
        "Le score mesure la probabilité de concrétiser (0-100). followUpDays = délai recommandé avant le prochain contact (0 = aucun suivi nécessaire).",
      prompt: `Objectif de l'appel : ${session.objective || "prospection commerciale"}\nNuméro appelé : ${session.to}\n\nTRANSCRIPTION :\n${transcriptOf(session.history)}`,
      schema: InsightSchema,
      label: "analyse d'appel commercial",
      maxTokens: 2_200,
    });

    const insight = result.data;
    // Planification automatique du rendez-vous de suivi (Scheduling Engine).
    let followUpEventId: string | null = null;
    if (insight.followUpDays > 0) {
      const startAt = new Date();
      startAt.setUTCDate(startAt.getUTCDate() + insight.followUpDays);
      startAt.setUTCHours(9, 0, 0, 0);
      const event = await createEvent({
        userId: user.uid,
        type: "appointment",
        title: `Suivi commercial — ${session.to}`,
        description: `${insight.followUpReason}\n\nRésumé : ${insight.summary}`,
        startAt: startAt.toISOString(),
        related: { module: "sales", refId: session.id },
      });
      followUpEventId = event.id;
    }

    const record = await createRecord({
      userId: user.uid,
      collection: COLLECTION,
      data: {
        callSessionId: session.id,
        to: session.to,
        objective: session.objective,
        insight,
        followUpEventId,
        provider: result.provider,
      },
    });

    void emitBusinessEvent({
      userId: user.uid,
      eventType: "sales.call_analyzed",
      payload: { insightId: record.id, callSessionId: session.id, to: session.to, score: insight.score, interestLevel: insight.interestLevel },
    }).catch(() => undefined);

    return NextResponse.json({ insight: unfoldRecord(record) }, { status: 201 });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Analyse d'appel impossible."), { status: errorStatus(error) });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const id = request.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Paramètre id requis." }, { status: 400 });
    const deleted = await deleteRecord(COLLECTION, user.uid, id);
    if (!deleted) return NextResponse.json({ error: "Analyse introuvable." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible."), { status: errorStatus(error) });
  }
}

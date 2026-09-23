import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { assertPhoneCallOwner, getPhoneCallSession } from "@/lib/integrations/twilio/calls";
import type { PhoneCallSession } from "@/lib/integrations/twilio/voice";
import { generateForUser } from "@/lib/billing/ai-execution";
import { adminDb } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

type Context = { params: Promise<{ id: string }> };

/**
 * Résumé IA d'un appel (Call App).
 *
 * Le transcript est résumé par le routeur IA facturé au propriétaire ; le
 * résumé est mis en cache sur la session (resume) — régénérable via
 * ?refresh=1. Un appel sans transcript retourne une réponse explicite
 * (pas de résumé inventé).
 */
export async function POST(request: NextRequest, context: Context) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const limit = await enforceRateLimit(`call-summary:${user.uid}`, { limit: 30, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de demandes de résumé." }, { status: 429 });

    await assertPhoneCallOwner(user.uid, id);
    const session = await getPhoneCallSession(id);
    if (!session) return NextResponse.json({ error: "Appel introuvable." }, { status: 404 });
    const cached = (session as PhoneCallSession & { resume?: string }).resume;

    const refresh = request.nextUrl.searchParams.get("refresh") === "1";
    if (cached && !refresh) {
      return NextResponse.json({ summary: cached, cached: true });
    }

    const transcript = (session.history ?? [])
      .map((item) => `${item.role === "assistant" ? "Agent" : "Correspondant"} : ${item.text}`)
      .join("\n");
    if (transcript.trim().length < 20) {
      return NextResponse.json({ error: "Aucun transcript exploitable pour cet appel (pas encore connecté, ou trop court)." }, { status: 409 });
    }

    const billed = await generateForUser({
      userId: user.uid,
      executionId: `call-summary-${id}`,
      complexity: 1,
      request: {
        task: "chat",
        preferFree: true,
        maxTokens: 800,
        messages: [
          {
            role: "system",
            content:
              "Tu résumes des appels téléphoniques passés par des agents IA Gen3ia. Produis : (1) un résumé en 2 à 4 phrases ; (2) les points clés en liste ; (3) toute demande ou réclamation du correspondant ; (4) l'action de suivi recommandée. Sois factuel : n'invente RIEN qui ne figure pas au transcript.",
          },
          { role: "user", content: `Objectif de l'appel : ${session.objective}\n\nTranscript :\n${transcript.slice(0, 12_000)}` },
        ],
      },
    });

    const summary = billed.response.text;
    await adminDb.collection("agentPhoneCalls").doc(id).update({ resume: summary, summarizedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
    return NextResponse.json({ summary, cached: false });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Résumé indisponible."), { status: errorStatus(error) });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { requireUser } from "@/lib/security/authenticated-request";
import { getAgentForOwner } from "@/lib/agents/repository";
import { listAgentPhoneNumbers } from "@/lib/integrations/twilio/numbers";
import { createPhoneCallSession, startPhoneCall } from "@/lib/integrations/twilio/calls";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { createPlivoPhoneCallSession, startPlivoPhoneCall } from "@/lib/integrations/plivo/calls";
import { errorStatus } from "@/lib/security/http-errors";

const CallSchema = z.object({
  to: z.string().regex(/^\+[1-9]\d{7,14}$/),
  objective: z.string().trim().min(3).max(4000).optional(),
});

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const limit = await enforceRateLimit(`voice-call:${user.uid}`, { limit: 10, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Limite d'appels vocaux atteinte pour cette heure." }, { status: 429 });

    const parsed = CallSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Numéro de destination invalide." }, { status: 400 });

    const agent = await getAgentForOwner(user.uid, id);
    if (!agent) return NextResponse.json({ error: "Agent introuvable." }, { status: 404 });
    if (!agent.voiceEnabled || agent.voiceConfig?.outboundEnabled === false) {
      return NextResponse.json({ error: "Les appels sortants sont désactivés pour cet agent." }, { status: 400 });
    }
    const assigned = (await listAgentPhoneNumbers(user.uid, id)).find((number) => number.status === "active");
    if (!assigned) return NextResponse.json({ error: "Attribuez d'abord un numéro de téléphone à cet agent." }, { status: 400 });

    const config = agent.voiceConfig;
    const sessionInput = {
      userId: user.uid,
      agentId: agent.id,
      executionId: randomUUID(),
      from: assigned.phoneNumber,
      to: parsed.data.to,
      objective: parsed.data.objective ?? (agent.description || "Assister le correspondant dans le périmètre de cet agent."),
      opening: config?.greeting ?? "Bonjour, je suis l'agent IA de Gen3ia. Comment puis-je vous aider ?",
      language: config?.language ?? "fr-FR",
      maxTurns: config?.maxTurns ?? 20,
      maxDurationSeconds: config?.maxDurationSeconds ?? 300,
      systemPrompt: agent.systemPrompt,
    };
    const session = assigned.provider === "plivo"
      ? await createPlivoPhoneCallSession(sessionInput)
      : await createPhoneCallSession(sessionInput);
    const call = assigned.provider === "plivo"
      ? await startPlivoPhoneCall(session.id)
      : await startPhoneCall(session.id);
    return NextResponse.json({ sessionId: session.id, callSid: call.callSid, status: call.status, from: assigned.phoneNumber, to: parsed.data.to });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Appel impossible." }, { status: errorStatus(error, 400) });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getAgentForOwner } from "@/lib/agents/repository";
import { listAgentPhoneNumbers } from "@/lib/integrations/twilio/numbers";
import { createPhoneCallSession, listPhoneCallSessions, startPhoneCall } from "@/lib/integrations/twilio/calls";
import { createPlivoPhoneCallSession, startPlivoPhoneCall } from "@/lib/integrations/plivo/calls";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Call App — API centrale des appels IA.
 *
 * GET  : historique des sessions d'appel (filtre agentId optionnel).
 * POST : lance un appel sortant avec l'agent vocal choisi (numéro attribué,
 *        objectif, langue, bornes de durée/tours), via Twilio ou Plivo
 *        selon le fournisseur du numéro attribué.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`voice-calls-list:${user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes." }, { status: 429 });
    const agentId = request.nextUrl.searchParams.get("agentId") ?? undefined;
    const sessions = await listPhoneCallSessions(user.uid, agentId, 40);
    return NextResponse.json({ sessions });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Historique d'appels indisponible."), { status: errorStatus(error) });
  }
}

const CallSchema = z.object({
  agentId: z.string().min(1).max(128),
  to: z.string().regex(/^\+[1-9]\d{7,14}$/),
  objective: z.string().trim().min(3).max(4_000).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`voice-call:${user.uid}`, { limit: 10, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Limite d'appels vocaux atteinte pour cette heure." }, { status: 429 });

    const parsed = CallSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Paramètres d'appel invalides (numéro au format +E164, agent requis)." }, { status: 400 });
    }

    const agent = await getAgentForOwner(user.uid, parsed.data.agentId);
    if (!agent) return NextResponse.json({ error: "Agent introuvable." }, { status: 404 });
    if (!agent.voiceEnabled || agent.voiceConfig?.outboundEnabled === false) {
      return NextResponse.json({ error: "Les appels sortants sont désactivés pour cet agent." }, { status: 400 });
    }
    const assigned = (await listAgentPhoneNumbers(user.uid, agent.id)).find((number) => number.status === "active");
    if (!assigned) return NextResponse.json({ error: "Attribuez d'abord un numéro de téléphone à cet agent (Paramètres · Numéros virtuels)." }, { status: 400 });

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
    return NextResponse.json({
      sessionId: session.id,
      callSid: call.callSid,
      status: call.status,
      from: assigned.phoneNumber,
      to: parsed.data.to,
      provider: assigned.provider ?? "twilio",
    });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Appel impossible."), { status: errorStatus(error) });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { getAgentForUser, updateAgentForUser } from "@/lib/agents/repository";
import { listAgentPhoneNumbers } from "@/lib/integrations/twilio/numbers";
import { errorStatus } from "@/lib/security/http-errors";

const VoicePatchSchema = z.object({
  voiceEnabled: z.boolean().optional(),
  language: z.enum(["fr-FR", "en-US", "en-GB", "es-ES", "de-DE"]).optional(),
  greeting: z.string().trim().min(2).max(800).optional(),
  maxTurns: z.number().int().min(1).max(40).optional(),
  maxDurationSeconds: z.number().int().min(30).max(1800).optional(),
  inboundEnabled: z.boolean().optional(),
  outboundEnabled: z.boolean().optional(),
});

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const agent = await getAgentForUser(user.uid, id);
    if (!agent) return NextResponse.json({ error: "Agent introuvable." }, { status: 404 });
    const numbers = await listAgentPhoneNumbers(user.uid, id);
    return NextResponse.json({ voice: agent.voiceConfig ?? null, numbers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Voice configuration unavailable." }, { status: errorStatus(error, 500) });
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const parsed = VoicePatchSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Configuration vocale invalide.", issues: parsed.error.flatten() }, { status: 400 });
    const agent = await getAgentForUser(user.uid, id);
    if (!agent) return NextResponse.json({ error: "Agent introuvable." }, { status: 404 });

    const current = agent.voiceConfig ?? {
      language: "fr-FR" as const,
      greeting: "Bonjour, je suis l'agent IA de Gen3ia. Comment puis-je vous aider ?",
      maxTurns: 20,
      maxDurationSeconds: 300,
      inboundEnabled: true,
      outboundEnabled: true,
    };
    const voiceConfig = { ...current, ...parsed.data };
    const updated = await updateAgentForUser(user.uid, id, { voiceEnabled: voiceConfig.voiceEnabled ?? true, voiceConfig });
    // Lecture ok mais écriture refusée (membre d'org en lecture seule) :
    // dénégation honnête plutôt qu'un 200 qui ferait croire au succès.
    if (!updated) return NextResponse.json({ error: "Action réservée au propriétaire ou aux administrateurs." }, { status: 403 });
    return NextResponse.json({ voice: updated.voiceConfig ?? voiceConfig });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Voice update failed." }, { status: errorStatus(error, 400) });
  }
}

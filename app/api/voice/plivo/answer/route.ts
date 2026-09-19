import { NextRequest } from "next/server";
import { getAgentForOwner } from "@/lib/agents/repository";
import { getAgentPhoneNumberByNumber } from "@/lib/integrations/twilio/numbers";
import { createInboundPhoneCallSession, appendPhoneCallHistory, updatePhoneCallStatus } from "@/lib/integrations/twilio/calls";
import { buildPlivoXML, escapePlivoXML, verifyPlivoSignature } from "@/lib/integrations/plivo/voice";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const params = Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
  if (!verifyPlivoSignature(request, params)) return new Response("Unauthorized", { status: 401 });

  const destination = String(params.To ?? "");
  const mapping = await getAgentPhoneNumberByNumber(destination);
  if (!mapping || mapping.provider !== "plivo") return new Response("No Gen3ia Plivo agent is assigned to this number.", { status: 404 });
  const agent = await getAgentForOwner(mapping.ownerId, mapping.agentId);
  if (!agent?.voiceEnabled || agent.voiceConfig?.inboundEnabled === false) {
    return buildPlivoXML("<Speak>Ce numéro n'accepte pas les appels pour le moment.</Speak><Hangup/>");
  }

  const session = await createInboundPhoneCallSession({
    userId: mapping.ownerId,
    agentId: agent.id,
    executionId: params.CallUUID ?? crypto.randomUUID(),
    to: destination,
    from: String(params.From ?? "unknown"),
    objective: agent.description || "Répondre aux appels entrants et aider l'appelant dans le périmètre de l'agent.",
    opening: agent.voiceConfig?.greeting ?? "Bonjour, je suis l'agent IA de Gen3ia. Comment puis-je vous aider ?",
    language: agent.voiceConfig?.language ?? "fr-FR",
    maxTurns: agent.voiceConfig?.maxTurns ?? 20,
    maxDurationSeconds: agent.voiceConfig?.maxDurationSeconds ?? 300,
    systemPrompt: agent.systemPrompt,
  });
  session.provider = "plivo";
  await updatePhoneCallStatus(session.id, "in-progress", params.CallUUID);
  await appendPhoneCallHistory(session.id, { role: "assistant", text: session.opening, at: new Date().toISOString() });

  const action = "/api/voice/plivo/turn?sessionId=" + encodeURIComponent(session.id);
  return buildPlivoXML('<GetInput inputType="speech" action="' + action + '" method="POST" language="' + escapePlivoXML(session.language) + '" speechModel="phone_call"><Speak>' + escapePlivoXML(session.opening) + "</Speak></GetInput><Speak>Je n'ai pas reçu de réponse. Au revoir.</Speak><Hangup/>");
}

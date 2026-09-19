import { generateForUser } from "@/lib/billing/ai-execution";
import { appendPhoneCallHistory, getPhoneCallSession, updatePhoneCallStatus } from "@/lib/integrations/twilio/calls";
import { buildPlivoXML, escapePlivoXML, verifyPlivoSignature } from "@/lib/integrations/plivo/voice";

export const runtime = "nodejs";

function compactHistory(history: Array<{ role: "assistant" | "user"; text: string }>) {
  return history.slice(-16).map((item) => item.role.toUpperCase() + ": " + item.text).join("\n");
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return new Response("Missing sessionId", { status: 400 });

  const form = await request.formData();
  const params = Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
  if (!verifyPlivoSignature(request, params)) return new Response("Unauthorized", { status: 401 });

  const session = await getPhoneCallSession(sessionId);
  if (!session || session.provider !== "plivo" || Date.now() > session.expiresAt) {
    return buildPlivoXML("<Speak>Cette session est terminée. Au revoir.</Speak><Hangup/>");
  }

  const speech = (params.Speech ?? "").trim().slice(0, 4000);
  const turnCount = session.history.filter((item) => item.role === "user").length + 1;
  if (!speech) {
    return buildPlivoXML('<GetInput inputType="speech" action="/api/voice/plivo/turn?sessionId=' + encodeURIComponent(session.id) + '" method="POST" language="' + escapePlivoXML(session.language) + '" speechModel="phone_call"><Speak>Pouvez-vous répéter, s’il vous plaît ?</Speak></GetInput><Hangup/>');
  }

  if (turnCount > session.maxTurns || Date.now() - session.createdAt > session.maxDurationSeconds * 1000) {
    await updatePhoneCallStatus(session.id, "completed", session.callSid);
    return buildPlivoXML("<Speak>Merci pour votre temps. Au revoir.</Speak><Hangup/>");
  }

  await appendPhoneCallHistory(session.id, { role: "user", text: speech, at: new Date().toISOString() });
  const fresh = await getPhoneCallSession(session.id);
  if (!fresh) return buildPlivoXML("<Hangup/>");

  const billed = await generateForUser({
    userId: fresh.userId,
    executionId: fresh.executionId,
    complexity: 1.2,
    request: {
      task: "agent",
      messages: [
        { role: "system", content: "You are a professional Gen3ia telephone agent. Your objective is: " + fresh.objective + ". The agent personality and system instructions are: " + (fresh.systemPrompt ?? "Be professional, helpful, concise and truthful.") + ". Speak naturally and briefly because the output will be read aloud on a phone call. Never claim an action happened unless it was actually completed. Never request passwords, API keys, full payment card data, or other secrets. If the objective is completed, end your response with the exact token [END_CALL]." },
        { role: "user", content: compactHistory(fresh.history) },
      ],
      maxTokens: 500,
    },
  });

  const spokenRaw = billed.response.text.trim().slice(0, 1800);
  const shouldEnd = spokenRaw.includes("[END_CALL]") || turnCount >= fresh.maxTurns;
  const spoken = spokenRaw.replaceAll("[END_CALL]", "").trim();
  await appendPhoneCallHistory(fresh.id, { role: "assistant", text: spoken, at: new Date().toISOString() });

  if (shouldEnd) {
    await updatePhoneCallStatus(fresh.id, "completed", fresh.callSid);
    return buildPlivoXML("<Speak>" + escapePlivoXML(spoken || "Merci pour votre temps. Au revoir.") + "</Speak><Hangup/>");
  }

  return buildPlivoXML('<GetInput inputType="speech" action="/api/voice/plivo/turn?sessionId=' + encodeURIComponent(fresh.id) + '" method="POST" language="' + escapePlivoXML(fresh.language) + '" speechModel="phone_call"><Speak>' + escapePlivoXML(spoken) + "</Speak></GetInput><Speak>Merci pour votre temps. Au revoir.</Speak><Hangup/>");
}

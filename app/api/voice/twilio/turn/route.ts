import { generateForUser } from "@/lib/billing/ai-execution";
import {
  appendPhoneCallHistory,
  getPhoneCallSession,
  incrementPhoneCallTurn,
  updatePhoneCallStatus,
} from "@/lib/integrations/twilio/calls";
import { buildTwiML, escapeXml, verifyTwilioSignature } from "@/lib/integrations/twilio/voice";

export const runtime = "nodejs";

function compactHistory(history: Array<{ role: "assistant" | "user"; text: string }>) {
  return history.slice(-16).map((item) => `${item.role.toUpperCase()}: ${item.text}`).join("\n");
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return new Response("Missing sessionId", { status: 400 });

  const form = await request.formData();
  const params = Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
  if (!verifyTwilioSignature(request, params)) return new Response("Unauthorized", { status: 401 });

  const session = await getPhoneCallSession(sessionId);
  if (!session || Date.now() > session.expiresAt) {
    return buildTwiML("<Say>Cette session est terminée. Au revoir.</Say><Hangup/>");
  }

  const speech = (params.SpeechResult ?? "").trim().slice(0, 4000);
  const turnCount = session.history.filter((item) => item.role === "user").length + 1;
  if (!speech) {
    return buildTwiML(`<Gather input="speech" action="/api/voice/twilio/turn?sessionId=${encodeURIComponent(session.id)}" method="POST" speechTimeout="2" timeout="8" language="${escapeXml(session.language)}" actionOnEmptyResult="true"><Say language="${escapeXml(session.language)}">Pouvez-vous répéter, s’il vous plaît ?</Say></Gather><Hangup/>`);
  }

  if (turnCount > session.maxTurns || Date.now() - session.createdAt > session.maxDurationSeconds * 1000) {
    await updatePhoneCallStatus(session.id, "completed", session.callSid);
    return buildTwiML("<Say>Merci pour votre temps. Au revoir.</Say><Hangup/>");
  }

  await appendPhoneCallHistory(session.id, { role: "user", text: speech, at: new Date().toISOString() });
  await incrementPhoneCallTurn(session.id);

  const fresh = await getPhoneCallSession(session.id);
  if (!fresh) return buildTwiML("<Hangup/>");

  const billed = await generateForUser({
    userId: fresh.userId,
    executionId: fresh.executionId,
    complexity: 1.2,
    request: {
      task: "agent",
      messages: [
        {
          role: "system",
          content:
            `You are a professional Gen3ia telephone agent. Your objective is: ${fresh.objective}. ` +
            "Speak naturally and briefly because the output will be read aloud on a phone call. " +
            "Never claim an action happened unless it was actually completed. Never request passwords, API keys, full payment card data, or other secrets. " +
            "If the caller asks for an action outside this objective, explain the limitation and stay within scope. " +
            "If the objective is completed, end your response with the exact token [END_CALL].",
        },
        {
          role: "user",
          content: compactHistory(fresh.history),
        },
      ],
      maxTokens: 500,
    },
  });

  const text = billed.response.text.trim().slice(0, 1800);
  const shouldEnd = text.includes("[END_CALL]") || turnCount >= fresh.maxTurns;
  const spoken = text.replaceAll("[END_CALL]", "").trim();

  await appendPhoneCallHistory(fresh.id, { role: "assistant", text: spoken, at: new Date().toISOString() });

  if (shouldEnd) {
    await updatePhoneCallStatus(fresh.id, "completed", fresh.callSid);
    return buildTwiML(`<Say language="${escapeXml(fresh.language)}">${escapeXml(spoken || "Merci pour votre temps. Au revoir.")}</Say><Hangup/>`);
  }

  const actionUrl = `/api/voice/twilio/turn?sessionId=${encodeURIComponent(fresh.id)}`;
  const xml = `<Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="2" timeout="8" language="${escapeXml(fresh.language)}" actionOnEmptyResult="true"><Say language="${escapeXml(fresh.language)}">${escapeXml(spoken)}</Say></Gather><Say language="${escapeXml(fresh.language)}">Merci pour votre temps. Au revoir.</Say><Hangup/>`;
  return buildTwiML(xml);
}

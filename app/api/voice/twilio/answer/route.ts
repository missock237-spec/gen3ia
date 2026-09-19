import { appendPhoneCallHistory, getPhoneCallSession, updatePhoneCallStatus } from "@/lib/integrations/twilio/calls";
import { buildTwiML, escapeXml, verifyTwilioSignature } from "@/lib/integrations/twilio/voice";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return new Response("Missing sessionId", { status: 400 });

  const form = await request.formData();
  const params = Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
  if (!verifyTwilioSignature(request, params)) return new Response("Unauthorized", { status: 401 });

  const session = await getPhoneCallSession(sessionId);
  if (!session || Date.now() > session.expiresAt) return new Response("Call session expired", { status: 410 });
  await updatePhoneCallStatus(session.id, "in-progress", params.CallSid);
  if (session.history.length === 0) {
    await appendPhoneCallHistory(session.id, { role: "assistant", text: session.opening, at: new Date().toISOString() });
  }

  const actionUrl = `/api/voice/twilio/turn?sessionId=${encodeURIComponent(session.id)}`;
  const prompt = session.opening || "Bonjour. Je vous écoute.";
  const xml = `<Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="2" timeout="8" language="${escapeXml(session.language)}" actionOnEmptyResult="true"><Say language="${escapeXml(session.language)}">${escapeXml(prompt)}</Say></Gather><Say language="${escapeXml(session.language)}">Je n’ai pas reçu de réponse. Au revoir.</Say><Hangup/>`;
  return buildTwiML(xml);
}

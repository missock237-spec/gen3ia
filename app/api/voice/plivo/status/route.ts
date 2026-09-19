import { updatePhoneCallStatus } from "@/lib/integrations/twilio/calls";
import { verifyPlivoSignature } from "@/lib/integrations/plivo/voice";

export const runtime = "nodejs";

const mapStatus: Record<string, "ringing" | "in-progress" | "completed" | "failed" | "busy" | "no-answer"> = {
  ringing: "ringing",
  "in-progress": "in-progress",
  completed: "completed",
  busy: "busy",
  "no-answer": "no-answer",
  failed: "failed",
};

export async function POST(request: Request) {
  const form = await request.formData();
  const params = Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
  if (!verifyPlivoSignature(request, params)) return new Response("Unauthorized", { status: 401 });
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (sessionId) await updatePhoneCallStatus(sessionId, mapStatus[String(params.CallStatus ?? "").toLowerCase()] ?? "completed", params.CallUUID);
  return new Response("OK", { status: 200 });
}

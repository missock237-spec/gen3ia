import { updatePhoneCallStatus } from "@/lib/integrations/twilio/calls";
import { verifyTwilioSignature } from "@/lib/integrations/twilio/voice";

export const runtime = "nodejs";

const STATUS_MAP: Record<string, "queued" | "ringing" | "in-progress" | "completed" | "failed" | "no-answer" | "busy" | "canceled"> = {
  queued: "queued",
  ringing: "ringing",
  "in-progress": "in-progress",
  completed: "completed",
  failed: "failed",
  "no-answer": "no-answer",
  busy: "busy",
  canceled: "canceled",
};

export async function POST(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return new Response("Missing sessionId", { status: 400 });

  let params: Record<string, string>;
  try {
    const form = await request.formData();
    params = Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
  } catch {
    return new Response("Invalid form data", { status: 400 });
  }
  if (!verifyTwilioSignature(request, params)) return new Response("Unauthorized", { status: 401 });

  const status = STATUS_MAP[params.CallStatus ?? ""];
  try {
    if (status) {
      await updatePhoneCallStatus(sessionId, status, params.CallSid);
    }
    return new Response("", { status: 204 });
  } catch {
    // 500 CONTRÔLÉ : Twilio re-tente la livraison du statut (un crash non
    // attrapé produirait la même réponse, sans garantie de logs propres).
    return new Response("Temporary error", { status: 500 });
  }
}

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
  let params: Record<string, string>;
  try {
    const form = await request.formData();
    params = Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
  } catch {
    return new Response("Invalid form data", { status: 400 });
  }
  if (!verifyPlivoSignature(request, params)) return new Response("Unauthorized", { status: 401 });
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  try {
    if (sessionId) await updatePhoneCallStatus(sessionId, mapStatus[String(params.CallStatus ?? "").toLowerCase()] ?? "completed", params.CallUUID);
    return new Response("OK", { status: 200 });
  } catch {
    // 500 CONTRÔLÉ : Plivo re-tente la livraison du statut (un crash non
    // attrapé produirait la même réponse, sans garantie de logs propres).
    return new Response("Temporary error", { status: 500 });
  }
}

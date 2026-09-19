import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { appendHistory, isValidE164, type PhoneCallSession } from "@/lib/integrations/twilio/voice";

const COLLECTION = "agentPhoneCalls";

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is not configured.");
  return value;
}

function config() {
  return {
    authId: requiredEnv("PLIVO_AUTH_ID"),
    authToken: requiredEnv("PLIVO_AUTH_TOKEN"),
    appUrl: requiredEnv("NEXT_PUBLIC_APP_URL").replace(/\/$/, ""),
  };
}

async function plivoRequest(path: string, body: Record<string, unknown>) {
  const c = config();
  const response = await fetch("https://api.plivo.com/v1/Account/" + encodeURIComponent(c.authId) + path, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(c.authId + ":" + c.authToken).toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.message ?? payload.error ?? "Plivo call failed."));
  return payload as Record<string, unknown>;
}

export async function createPlivoPhoneCallSession(params: {
  userId: string; executionId: string; agentId: string; systemPrompt?: string; to: string; from: string;
  objective: string; opening: string; language: string; maxTurns: number; maxDurationSeconds: number;
}) {
  if (!isValidE164(params.to) || !isValidE164(params.from)) throw new Error("Phone numbers must use E.164 format.");
  const id = randomUUID();
  const now = Date.now();
  const session: PhoneCallSession = {
    id, provider: "plivo", userId: params.userId, executionId: params.executionId, agentId: params.agentId,
    systemPrompt: params.systemPrompt, to: params.to, from: params.from, objective: params.objective, opening: params.opening,
    language: params.language, maxTurns: params.maxTurns, maxDurationSeconds: params.maxDurationSeconds,
    status: "queued", history: [], createdAt: now, updatedAt: now,
    expiresAt: now + (params.maxDurationSeconds + 120) * 1000,
  };
  await adminDb.collection(COLLECTION).doc(id).set(session);
  return session;
}

export async function startPlivoPhoneCall(sessionId: string) {
  const ref = adminDb.collection(COLLECTION).doc(sessionId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Phone call session not found.");
  const session = snap.data() as PhoneCallSession;
  const c = config();
  const payload = await plivoRequest("/Call/", {
    from: session.from,
    to: session.to,
    answer_url: c.appUrl + "/api/voice/plivo/answer?sessionId=" + encodeURIComponent(session.id),
    answer_method: "POST",
    hangup_url: c.appUrl + "/api/voice/plivo/status?sessionId=" + encodeURIComponent(session.id),
    hangup_method: "POST",
    time_limit: session.maxDurationSeconds,
  });
  const callUuid = String(payload.request_uuid ?? payload.call_uuid ?? "");
  if (!callUuid) {
    await ref.update({ status: "failed", lastError: "Plivo did not return a call identifier.", updatedAt: Date.now() });
    throw new Error("Plivo did not return a call identifier.");
  }
  await ref.update({ callSid: callUuid, status: "ringing", updatedAt: Date.now() });
  return { callSid: callUuid, status: "ringing" };
}

export async function getPlivoPhoneCallSession(sessionId: string) {
  const snap = await adminDb.collection(COLLECTION).doc(sessionId).get();
  return snap.exists ? (snap.data() as PhoneCallSession) : null;
}

export async function updatePlivoPhoneCallStatus(sessionId: string, status: PhoneCallSession["status"], callSid?: string) {
  await adminDb.collection(COLLECTION).doc(sessionId).update({ status, ...(callSid ? { callSid } : {}), updatedAt: Date.now() });
}

export async function appendPlivoPhoneCallHistory(sessionId: string, item: PhoneCallSession["history"][number]) {
  const session = await getPlivoPhoneCallSession(sessionId);
  if (!session) throw new Error("Phone call session not found.");
  await adminDb.collection(COLLECTION).doc(sessionId).update({ history: appendHistory(session.history, item), updatedAt: Date.now() });
}

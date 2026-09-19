import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import {
  appendHistory,
  getTwilioConfig,
  isValidE164,
  type PhoneCallSession,
} from "./voice";

const COLLECTION = "agentPhoneCalls";

function assertOwner(userId: string) {
  if (!userId.trim()) throw new Error("Missing user id.");
}

export async function createPhoneCallSession(params: {
  userId: string;
  executionId: string;
  to: string;
  objective: string;
  opening: string;
  language: string;
  maxTurns: number;
  maxDurationSeconds: number;
}) {
  assertOwner(params.userId);
  if (!isValidE164(params.to)) throw new Error("Phone number must use E.164 format, for example +2376XXXXXXXX.");
  const config = getTwilioConfig();
  const id = randomUUID();
  const now = Date.now();
  const session: PhoneCallSession = {
    id,
    userId: params.userId,
    executionId: params.executionId,
    to: params.to,
    from: config.fromNumber,
    objective: params.objective,
    opening: params.opening,
    language: params.language,
    maxTurns: params.maxTurns,
    maxDurationSeconds: params.maxDurationSeconds,
    status: "queued",
    history: [],
    createdAt: now,
    updatedAt: now,
    expiresAt: now + (params.maxDurationSeconds + 120) * 1000,
  };

  await adminDb.collection(COLLECTION).doc(id).set(session);
  return session;
}

export async function startPhoneCall(sessionId: string) {
  const ref = adminDb.collection(COLLECTION).doc(sessionId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Phone call session not found.");
  const session = snap.data() as PhoneCallSession;
  const config = getTwilioConfig();

  const body = new URLSearchParams({
    To: session.to,
    From: session.from,
    Url: `${config.appUrl}/api/voice/twilio/answer?sessionId=${encodeURIComponent(session.id)}`,
    Method: "POST",
    StatusCallback: `${config.appUrl}/api/voice/twilio/status?sessionId=${encodeURIComponent(session.id)}`,
    StatusCallbackMethod: "POST",
    Timeout: "30",
  });
  body.append("StatusCallbackEvent", "completed");

  const basic = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Calls.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );

  const payload = await response.json().catch(() => ({})) as { sid?: string; status?: string; message?: string; code?: string };
  if (!response.ok || !payload.sid) {
    await ref.update({
      status: "failed",
      lastError: payload.message ?? `Twilio returned HTTP ${response.status}.`,
      updatedAt: Date.now(),
    });
    throw new Error(payload.message ?? "Twilio could not create the call.");
  }

  await ref.update({
    callSid: payload.sid,
    status: payload.status === "queued" ? "queued" : "ringing",
    updatedAt: Date.now(),
  });

  return { callSid: payload.sid, status: payload.status ?? "queued" };
}

export async function getPhoneCallSession(sessionId: string) {
  const snap = await adminDb.collection(COLLECTION).doc(sessionId).get();
  return snap.exists ? (snap.data() as PhoneCallSession) : null;
}

export async function assertPhoneCallOwner(userId: string, sessionId: string) {
  const session = await getPhoneCallSession(sessionId);
  if (!session || session.userId !== userId) throw new Error("Phone call session not found.");
  return session;
}

export async function updatePhoneCallStatus(sessionId: string, status: PhoneCallSession["status"], callSid?: string, error?: string) {
  await adminDb.collection(COLLECTION).doc(sessionId).update({
    status,
    ...(callSid ? { callSid } : {}),
    ...(error ? { lastError: error } : {}),
    updatedAt: Date.now(),
  });
}

export async function appendPhoneCallHistory(sessionId: string, item: PhoneCallSession["history"][number]) {
  const session = await getPhoneCallSession(sessionId);
  if (!session) throw new Error("Phone call session not found.");
  await adminDb.collection(COLLECTION).doc(sessionId).update({
    history: appendHistory(session.history, item),
    updatedAt: Date.now(),
  });
}

export async function incrementPhoneCallTurn(sessionId: string) {
  const ref = adminDb.collection(COLLECTION).doc(sessionId);
  await ref.update({ turnCount: FieldValue.increment(1), updatedAt: Date.now() });
}

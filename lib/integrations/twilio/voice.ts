import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_HISTORY = 40;

export interface PhoneCallSession {
  id: string;
  provider?: "twilio" | "plivo";
  userId: string;
  executionId: string;
  agentId?: string;
  systemPrompt?: string;
  to: string;
  from: string;
  objective: string;
  opening: string;
  language: string;
  maxTurns: number;
  maxDurationSeconds: number;
  status: "queued" | "ringing" | "in-progress" | "completed" | "failed" | "no-answer" | "busy" | "canceled";
  callSid?: string;
  history: Array<{ role: "assistant" | "user"; text: string; at: string }>;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  lastError?: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export function getTwilioConfig() {
  return {
    accountSid: requiredEnv("TWILIO_ACCOUNT_SID"),
    authToken: requiredEnv("TWILIO_AUTH_TOKEN"),
    fromNumber: process.env.TWILIO_PHONE_NUMBER?.trim() || "",
    appUrl: requiredEnv("NEXT_PUBLIC_APP_URL").replace(/\/$/, ""),
  };
}

export function isValidE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildTwiML(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function verifyTwilioSignature(
  request: Request,
  params: Record<string, string>,
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const signature = request.headers.get("x-twilio-signature")?.trim();
  if (!authToken || !signature) return false;

  const configuredUrl = process.env.TWILIO_WEBHOOK_BASE_URL?.trim();
  const url = configuredUrl
    ? new URL(request.url).pathname + new URL(request.url).search
    : request.url;
  const base = configuredUrl ? `${configuredUrl.replace(/\/$/, "")}${new URL(request.url).pathname}${new URL(request.url).search}` : url;

  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], base);

  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export function appendHistory(
  history: PhoneCallSession["history"],
  item: PhoneCallSession["history"][number],
) {
  return [...history, item].slice(-MAX_HISTORY);
}

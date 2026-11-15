import crypto from "node:crypto";

function getSharedSecret(): string {
  const secret = process.env.SANDBOX_SHARED_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SANDBOX_SHARED_SECRET must be at least 32 characters");
  }
  return secret;
}

const seenRequests = new Map<string, number>();
const MAX_SKEW_MS = 30_000;
const MAX_REPLAY_ENTRIES = 10_000;

export function signPayload(payload: string, timestamp: string): string {
  return crypto
    .createHmac("sha256", getSharedSecret())
    .update(`${timestamp}.${payload}`)
    .digest("hex");
}

function cleanup(now: number) {
  for (const [key, expiresAt] of seenRequests) {
    if (expiresAt <= now) seenRequests.delete(key);
  }
  while (seenRequests.size > MAX_REPLAY_ENTRIES) {
    const first = seenRequests.keys().next().value as string | undefined;
    if (!first) break;
    seenRequests.delete(first);
  }
}

export function verifySignature(
  payload: string,
  timestamp: string,
  signature: string,
  requestId?: string
): boolean {
  const now = Date.now();
  cleanup(now);

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > MAX_SKEW_MS) {
    return false;
  }

  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  if (requestId && !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) return false;

  const expected = signPayload(payload, timestamp);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  const replayKey = requestId
    ? `${requestId}:${signature}`
    : `${timestamp}:${signature}`;
  if (seenRequests.has(replayKey)) return false;
  seenRequests.set(replayKey, now + MAX_SKEW_MS);

  return true;
}

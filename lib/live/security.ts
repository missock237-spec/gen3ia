import crypto from "node:crypto";
import path from "node:path";
import type { LiveAction, LivePermission } from "./types";

const ACTION_PERMISSION: Record<LiveAction["type"], LivePermission | null> = {
  "mouse.move": "input.mouse",
  "mouse.click": "input.mouse",
  "keyboard.type": "input.keyboard",
  "keyboard.key": "input.keyboard",
  "file.read": "files.read",
  "file.write": "files.write",
  wait: null,
};

export function hashPairingToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function createPairingToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function assertActionAllowed(action: LiveAction, permissions: LivePermission[]): void {
  const required = ACTION_PERMISSION[action.type];
  if (required && !permissions.includes(required)) throw new Error(`Live permission denied: ${required}`);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export function resolveLiveFilePath(root: string, requestedPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requestedPath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Live file path escapes the authorized root.");
  }
  return resolved;
}

export function assertSafeLiveFilePath(requestedPath: string): void {
  if (!requestedPath.trim() || requestedPath.includes("\0") || requestedPath.includes("\\") || requestedPath.split("/").includes("..")) {
    throw new Error("Unsafe live file path.");
  }
}

const LIVE_PROTOCOL_WINDOW_MS = 10_000;
const LIVE_PROTOCOL_MAX_MESSAGES = 40;
const LIVE_MAX_AUTH_FAILURES = 5;

export class LiveRateLimiter {
  private windowStartedAt = Date.now();
  private messageCount = 0;
  allow(now = Date.now()): boolean {
    if (now - this.windowStartedAt >= LIVE_PROTOCOL_WINDOW_MS) {
      this.windowStartedAt = now;
      this.messageCount = 0;
    }
    this.messageCount += 1;
    return this.messageCount <= LIVE_PROTOCOL_MAX_MESSAGES;
  }
}

export class LiveAuthFailureLimiter {
  private failures = 0;
  registerFailure(): boolean {
    this.failures += 1;
    return this.failures <= LIVE_MAX_AUTH_FAILURES;
  }
}

export function assertFreshLiveTimestamp(timestamp: number, now = Date.now()): void {
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 30_000) {
    throw new Error("Live message timestamp is outside the allowed clock window.");
  }
}

/** Taille maximale d'une frame JPEG Live, en octets (identique gateway et API). */
export const LIVE_MAX_FRAME_BYTES = 1_500_000;

/**
 * Valide une frame JPEG transportée en base64 (encodage, taille, décodage).
 * Utilisée à la fois par la gateway WebSocket et par l'API HTTP du mode
 * navigateur afin d'appliquer exactement les mêmes règles.
 */
export function validateFrameBase64(value: string): Buffer {
  if (value.length > Math.ceil((LIVE_MAX_FRAME_BYTES * 4) / 3) + 4) throw new Error("Live frame is too large");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) throw new Error("Invalid frame encoding");
  const buffer = Buffer.from(value, "base64");
  if (buffer.length === 0 || buffer.length > LIVE_MAX_FRAME_BYTES) throw new Error("Invalid live frame size");
  return buffer;
}

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getAppUrl } from "@/lib/url/app-url";

/**
 * Approbation distante des actions sensibles depuis WhatsApp / Telegram.
 *
 * Quand une approbation est créée, l'agent peut notifier l'utilisateur sur son
 * canal de messagerie avec deux liens signés (Approuver / Refuser). Les liens
 * portent un token HMAC-SHA256 borné dans le temps : aucun cookie de session
 * n'est nécessaire sur le téléphone, et le token ne permet d'agir que sur
 * UNE approbation précise, avant son expiration.
 */

export interface RemoteApprovalTokenPayload {
  approvalId: string;
  ownerId: string;
  expiresAt: number;
}

function signingSecret(): string {
  if (process.env.REMOTE_APPROVAL_SECRET?.trim()) {
    return process.env.REMOTE_APPROVAL_SECRET.trim();
  }
  // Repli déterministe côté serveur uniquement : dérivée du matériel de
  // signature Firebase. Jamais exposée au client, jamais stockée en clair.
  return createHash("sha256")
    .update(`${process.env.FIREBASE_PRIVATE_KEY ?? ""}|${process.env.FIREBASE_PROJECT_ID ?? ""}|gen3ia-remote-approval-v1`)
    .digest("hex");
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function signatureOf(payload: RemoteApprovalTokenPayload): string {
  return createHmac("sha256", signingSecret())
    .update(`${payload.approvalId}.${payload.ownerId}.${payload.expiresAt}`)
    .digest("base64url");
}

export function signRemoteApprovalToken(payload: RemoteApprovalTokenPayload): string {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${signatureOf(payload)}`;
}

export function verifyRemoteApprovalToken(token: string): RemoteApprovalTokenPayload | null {
  if (!token || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as RemoteApprovalTokenPayload;
    if (typeof payload.approvalId !== "string" || typeof payload.ownerId !== "string" || typeof payload.expiresAt !== "number") return null;
    if (!payload.approvalId || !payload.ownerId || !Number.isFinite(payload.expiresAt)) return null;
    const expected = signatureOf(payload);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (Date.now() >= payload.expiresAt) return null;
    return payload;
  } catch {
    return null;
  }
}

export interface RemoteApprovalLinks {
  approveUrl: string;
  rejectUrl: string;
}

export function buildRemoteApprovalLinks(approvalId: string, ownerId: string, expiresAt: number): RemoteApprovalLinks {
  const token = signRemoteApprovalToken({ approvalId, ownerId, expiresAt });
  const base = getAppUrl().replace(/\/$/, "");
  return {
    approveUrl: `${base}/approvals/${encodeURIComponent(approvalId)}?token=${encodeURIComponent(token)}`,
    rejectUrl: `${base}/approvals/${encodeURIComponent(approvalId)}?token=${encodeURIComponent(token)}`,
  };
}

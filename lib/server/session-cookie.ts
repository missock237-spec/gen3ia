import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Session serveur signee (cookie HTTP-only).
 *
 * Le SDK Firebase client conserve l'etat de connexion dans le stockage du
 * navigateur (IndexedDB/localStorage). Sur certains navigateurs mobiles ou
 * webviews (cookies tiers bloques autour de l'authDomain, stockage
 * partitionne, mode prive), cet etat peut disparaitre : l'utilisateur est
 * alors refuse par les pages protegees alors que l'authentification a
 * reussi. Ce cookie signe sert de source de verite de secours cote serveur.
 */

export const SESSION_COOKIE_NAME = "gen3ia_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 jours

export interface SessionPayload {
  uid: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  provider: string;
  exp: number; // epoch seconds
}

function signingSecret(): Buffer {
  // Secret dédié si fourni : la rotation des credentials Firebase ne
  // doit JAMAIS invalider en masse les cookies de session (déconnexions
  // généralisées silencieuses). À configurer : SESSION_SECRET (>= 32 chars).
  const explicit = process.env.SESSION_SECRET?.trim();
  if (explicit) {
    return createHash("sha256").update(`gen3ia-session-secret|${explicit}`).digest();
  }

  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL ?? "";
  const projectId =
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ||
    "demo-gen3ia";

  // Cle derivee de variables d'environnement stables : identique sur toutes
  // les instances serverless, sans nouvelle variable a configurer.
  return createHash("sha256")
    .update(`${projectId}|${clientEmail}|${privateKey}`)
    .digest();
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function hmac(data: string): Buffer {
  return createHmac("sha256", signingSecret()).update(data).digest();
}

export function signSessionPayload(
  payload: Omit<SessionPayload, "exp"> & { exp?: number },
): string {
  const full: SessionPayload = {
    ...payload,
    exp: payload.exp ?? Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  };
  const body = base64url(JSON.stringify(full));
  const signature = base64url(hmac(body));
  return `${body}.${signature}`;
}

export function verifySessionCookie(value: string | undefined | null): SessionPayload | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const [body, signature] = parts;
  const expected = hmac(body);
  const provided = Buffer.from(signature, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (typeof payload.uid !== "string" || payload.uid.length === 0) return null;
    if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function readSessionCookie(cookieHeader: string | null | undefined): SessionPayload | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) {
      return verifySessionCookie(rest.join("="));
    }
  }
  return null;
}

export function sessionCookieHeader(payload: Omit<SessionPayload, "exp">): string {
  const value = signSessionPayload(payload);
  const attributes = [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  return attributes.join("; ");
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

import { createPublicKey, createVerify, type KeyObject } from "node:crypto";

import type { DecodedIdToken } from "firebase-admin/auth";

import { readSessionCookie } from "@/lib/server/session-cookie";

/**
 * Vérification serveur des Firebase ID tokens.
 *
 * Production: validation JWT RS256 contre les certificats publics Google.
 * Emulator: Firebase Admin verifyIdToken() est utilisé uniquement lorsque
 * FIREBASE_AUTH_EMULATOR_HOST est présent, afin que l'E2E local reproduise
 * réellement le flux Auth -> API -> Firestore sans contourner l'authentification.
 */

const GOOGLE_CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

interface TokenHeader {
  alg: string;
  typ?: string;
  kid?: string;
}

interface TokenPayload {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  iat?: number;
  auth_time?: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  phone_number?: string;
  firebase?: {
    identities?: Record<string, unknown>;
    sign_in_provider?: string;
    tenant?: string;
  };
  [key: string]: unknown;
}

let certCache: {
  keys: Record<string, KeyObject>;
  fetchedAt: number;
  maxAgeMs: number;
} | undefined;

async function fetchGooglePublicKeys(
  force = false,
): Promise<Record<string, KeyObject>> {
  if (
    !force &&
    certCache &&
    Date.now() < certCache.fetchedAt + certCache.maxAgeMs
  ) {
    return certCache.keys;
  }

  const response = await fetch(GOOGLE_CERTS_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `Impossible de récupérer les certificats publics Google (HTTP ${response.status}).`,
    );
  }

  const cacheControl = response.headers.get("cache-control") ?? "";
  const maxAgeSeconds = Number(/max-age=(\d+)/.exec(cacheControl)?.[1] ?? 3600);
  const certificates = (await response.json()) as Record<string, string>;
  const keys: Record<string, KeyObject> = {};

  for (const [kid, pem] of Object.entries(certificates)) {
    keys[kid] = createPublicKey(pem);
  }

  certCache = {
    keys,
    fetchedAt: Date.now(),
    maxAgeMs: Math.max(60, maxAgeSeconds) * 1000,
  };
  return keys;
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function expectedProjectId(): string {
  return (
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ||
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    ""
  );
}

async function verifyWithEmulator(token: string): Promise<DecodedIdToken> {
  const { getApps } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");
  const { getAdminApp } = await import("./admin");

  if (getApps().length === 0) getAdminApp();
  return getAuth().verifyIdToken(token, true);
}

export async function verifyFirebaseToken(
  authorizationHeader: string | null,
): Promise<DecodedIdToken> {
  if (!authorizationHeader) throw new Error("Missing authorization header.");
  if (!authorizationHeader.startsWith("Bearer ")) {
    throw new Error("Invalid authorization scheme.");
  }

  const token = authorizationHeader.slice(7).trim();
  if (!token) throw new Error("Missing Firebase ID token.");

  try {
    if (process.env.FIREBASE_AUTH_EMULATOR_HOST?.trim()) {
      return await verifyWithEmulator(token);
    }

    const projectId = expectedProjectId();
    if (!projectId) {
      throw new Error(
        "Firebase project id is not configured (NEXT_PUBLIC_FIREBASE_PROJECT_ID).",
      );
    }

    const segments = token.split(".");
    if (segments.length !== 3) throw new Error("Malformed JWT.");

    const header = decodeSegment(segments[0]!) as TokenHeader;
    const payload = decodeSegment(segments[1]!) as TokenPayload;
    const signature = Buffer.from(segments[2]!, "base64url");

    if (header.alg !== "RS256") {
      throw new Error(`Unexpected JWT alg: ${String(header.alg)}.`);
    }
    const kid = header.kid;
    if (!kid) throw new Error("Missing JWT kid.");

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp <= now) {
      throw new Error("Token expired.");
    }
    if (typeof payload.iat !== "number" || payload.iat > now + 300) {
      throw new Error("Token issued in the future.");
    }
    if (typeof payload.auth_time === "number" && payload.auth_time > now + 300) {
      throw new Error("Token auth_time in the future.");
    }
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("Token subject is empty.");
    }
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
      throw new Error(`Token issuer mismatch: ${String(payload.iss)}.`);
    }
    if (payload.aud !== projectId) {
      throw new Error(`Token audience mismatch: ${String(payload.aud)}.`);
    }

    let keys = await fetchGooglePublicKeys();
    let publicKey = keys[kid];
    if (!publicKey) {
      keys = await fetchGooglePublicKeys(true);
      publicKey = keys[kid];
    }
    if (!publicKey) throw new Error(`Unknown JWT kid: ${kid}.`);

    const signatureValid = createVerify("RSA-SHA256")
      .update(`${segments[0]}.${segments[1]}`)
      .verify(publicKey, signature);
    if (!signatureValid) throw new Error("Invalid JWT signature.");

    return {
      ...payload,
      uid: payload.sub,
      firebase: {
        identities: payload.firebase?.identities ?? {},
        sign_in_provider: payload.firebase?.sign_in_provider ?? "unknown",
        ...(payload.firebase?.tenant ? { tenant: payload.firebase.tenant } : {}),
      },
    } as unknown as DecodedIdToken;
  } catch (error) {
    console.warn(
      "[auth-server] ID token verification failed:",
      error instanceof Error ? error.message : error,
    );
    throw new Error("Invalid or revoked Firebase ID token.");
  }
}

/**
 * Authentification de requete par Bearer Firebase OU cookie de session signe.
 *
 * 1. Bearer : ID token Firebase (signature RS256 Google).
 * 2. Cookie `gen3ia_session` (HMAC serveur) : sauvegarde quand l'etat du SDK
 *    Firebase client a ete perdu (webviews mobiles, stockage bloque) — sans
 *    cela, l'utilisateur authentifie se verrait refuser toutes les
 *    fonctionnalites de la plateforme.
 *
 * L'objet retourne imite DecodedIdToken ; le cookie ne transporte pas de
 * custom claims (admin etc.), qui restent reserves au chemin Bearer.
 */
export async function verifyFirebaseAuth(
  request: Request | { headers: { get(name: string): string | null } },
): Promise<DecodedIdToken> {
  const authorization = request.headers.get("authorization");
  if (authorization && authorization.toLowerCase().startsWith("bearer ")) {
    try {
      return await verifyFirebaseToken(authorization);
    } catch {
      // Token absent/invalide : on tente le cookie avant d'echouer.
    }
  }

  const session = readSessionCookie(request.headers.get("cookie"));
  if (session) {
    return {
      uid: session.uid,
      sub: session.uid,
      email: session.email ?? undefined,
      name: session.name ?? undefined,
      picture: session.picture ?? undefined,
      firebase: { identities: {}, sign_in_provider: session.provider },
    } as unknown as DecodedIdToken;
  }

  throw new Error("Missing authorization header.");
}

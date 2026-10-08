import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { LiveVoiceErrorCode, LiveVoiceSessionPayload } from "./protocol";

/**
 * Jeton de session « Live Voix » — HMAC-SHA256 SANS ÉTAT (Task 110-a).
 *
 * La session vit entièrement dans un jeton signé `{uid, conversationId,
 * epoch, issuedAt, exp, jti}` (base64url du JSON + signature) : aucun stockage
 * serveur, compatible serverless. Le secret de signature est LU À CHAQUE
 * APPEL (fail-closed : absence → LIVE_UNCONFIGURED, jamais de signature avec
 * un secret vide). Durée par défaut 10 min, grâce de vérification 60 s pour
 * les tours en vol, renouvellement plafonné à LIVE_VOICE_MAX_EPOCHS epochs.
 */

/** Durée d'une session Live Voix (ms) — défaut 10 minutes. */
export const LIVE_VOICE_SESSION_MS = positiveIntEnv("LIVE_VOICE_SESSION_MS", 600_000);

/** Grâce de vérification pour les tours en vol au moment de l'expiration. */
export const LIVE_VOICE_GRACE_MS = 60_000;

/** Nombre maximal de renouvellements (epochs) d'une session — défaut 6 (= 60 min). */
export const LIVE_VOICE_MAX_EPOCHS = positiveIntEnv("LIVE_VOICE_MAX_EPOCHS", 6);

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Erreur portant un code du protocole (mappée en statut HTTP par les routes). */
export class LiveVoiceSessionError extends Error {
  readonly code: LiveVoiceErrorCode;

  constructor(code: LiveVoiceErrorCode, message: string) {
    super(message);
    this.name = "LiveVoiceSessionError";
    this.code = code;
  }
}

/**
 * Statut HTTP associé à un code du protocole (réponses JSON des routes —
 * dans le flux NDJSON, les codes voyagent dans l'événement `error`).
 */
export function liveVoiceErrorStatus(code: LiveVoiceErrorCode): number {
  switch (code) {
    case "LIVE_INSUFFICIENT_FUNDS":
      return 402;
    case "LIVE_SESSION_EXPIRED":
      return 401;
    case "LIVE_SESSION_INVALID":
    case "LIVE_PC_ONLY":
      return 403;
    case "LIVE_RATE_LIMITED":
      return 429;
    case "LIVE_UNCONFIGURED":
      return 503;
    default:
      return 500;
  }
}

/** Codes du protocole reconnus (garde-fou contre un `code` arbitraire). */
const PROTOCOL_CODES: readonly LiveVoiceErrorCode[] = [
  "LIVE_INSUFFICIENT_FUNDS",
  "LIVE_SESSION_EXPIRED",
  "LIVE_SESSION_INVALID",
  "LIVE_PC_ONLY",
  "LIVE_RATE_LIMITED",
  "LIVE_TURN_FAILED",
  "LIVE_STT_EMPTY",
  "LIVE_UNCONFIGURED",
];

/**
 * Extrait le code du protocole porté par une erreur (classe session, classe
 * billing ou toute erreur marquée d'un `code` connu) ; repli LIVE_TURN_FAILED.
 */
export function liveVoiceErrorCodeOf(error: unknown): LiveVoiceErrorCode {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    // includes() ne resserre pas le type : le test de liste est fait sur
    // string[], l'affinage vers le code du protocole est donc explicite.
    if (typeof code === "string" && (PROTOCOL_CODES as readonly string[]).includes(code)) {
      return code as LiveVoiceErrorCode;
    }
  }
  return "LIVE_TURN_FAILED";
}

/** Message lisible d'une erreur (réponses JSON / événements error). */
export function liveVoiceErrorMessageOf(error: unknown, fallback = "Le tour de parole a échoué."): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Secret de signature : LIVE_VOICE_SECRET, sinon CRON_SECRET (repli de
 * l'orchestrateur). Aucun secret → LIVE_UNCONFIGURED (fail-closed).
 */
function liveVoiceSecret(): string {
  const secret = process.env.LIVE_VOICE_SECRET || process.env.CRON_SECRET;
  if (!secret || !secret.trim()) {
    throw new LiveVoiceSessionError(
      "LIVE_UNCONFIGURED",
      "La session Live Voix n'est pas configurée : aucun secret de signature (LIVE_VOICE_SECRET ou CRON_SECRET).",
    );
  }
  return secret;
}

function encodePayload(payload: LiveVoiceSessionPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function hmac(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/**
 * Signe une nouvelle session Live Voix. `epoch` vaut 1 à la création et
 * epoch+1 à chaque renouvellement ; la validité va de l'émission jusqu'à
 * `issuedAt + LIVE_VOICE_SESSION_MS`.
 */
export function signLiveVoiceSession(
  params: { uid: string; conversationId: string; epoch?: number },
  now: number = Date.now(),
): { token: string; payload: LiveVoiceSessionPayload } {
  if (!params.uid || !params.conversationId) {
    throw new LiveVoiceSessionError(
      "LIVE_SESSION_INVALID",
      "La session Live Voix exige un utilisateur et une conversation.",
    );
  }
  const issuedAt = Math.floor(now);
  const payload: LiveVoiceSessionPayload = {
    uid: params.uid,
    conversationId: params.conversationId,
    epoch: Math.max(1, Math.floor(params.epoch ?? 1)),
    issuedAt,
    exp: issuedAt + LIVE_VOICE_SESSION_MS,
    jti: randomUUID(),
  };
  const body = encodePayload(payload);
  const signature = hmac(liveVoiceSecret(), body);
  return { token: `${body}.${signature}`, payload };
}

/**
 * Vérifie un jeton de session : signature HMAC (comparaison à temps
 * constant), forme de la charge utile, puis expiration avec grâce.
 *  - `graceMs`    : tolérance après `exp` (défaut LIVE_VOICE_GRACE_MS = 60 s)
 *    pour laisser finir les tours en vol ;
 *  - `allowExpired`: vérification SOUPLE (route stop) — l'expiration est
 *    ignorée, la signature reste obligatoire.
 * Jeton expiré → LIVE_SESSION_EXPIRED ; signature/forme invalide →
 * LIVE_SESSION_INVALID ; secret absent → LIVE_UNCONFIGURED.
 */
export function verifyLiveVoiceSession(
  token: string,
  options: { graceMs?: number; allowExpired?: boolean } = {},
): LiveVoiceSessionPayload {
  const secret = liveVoiceSecret();
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new LiveVoiceSessionError(
      "LIVE_SESSION_INVALID",
      "Jeton de session Live Voix absent ou mal formé.",
    );
  }
  const [body, signature] = parts;
  const expected = Buffer.from(hmac(secret, body), "utf8");
  const received = Buffer.from(signature, "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new LiveVoiceSessionError(
      "LIVE_SESSION_INVALID",
      "Signature de session Live Voix invalide.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new LiveVoiceSessionError(
      "LIVE_SESSION_INVALID",
      "Charge utile de session Live Voix illisible.",
    );
  }
  const payload = parsed as Partial<LiveVoiceSessionPayload> | null;
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.uid !== "string" ||
    !payload.uid ||
    typeof payload.conversationId !== "string" ||
    !payload.conversationId ||
    typeof payload.epoch !== "number" ||
    !Number.isFinite(payload.epoch) ||
    payload.epoch < 1 ||
    typeof payload.issuedAt !== "number" ||
    !Number.isFinite(payload.issuedAt) ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    typeof payload.jti !== "string" ||
    !payload.jti
  ) {
    throw new LiveVoiceSessionError(
      "LIVE_SESSION_INVALID",
      "Charge utile de session Live Voix incomplète.",
    );
  }

  const grace = options.allowExpired ? Number.POSITIVE_INFINITY : Math.max(0, options.graceMs ?? LIVE_VOICE_GRACE_MS);
  if (Date.now() > payload.exp + grace) {
    throw new LiveVoiceSessionError(
      "LIVE_SESSION_EXPIRED",
      "Session Live Voix expirée : renouvelez la session ou démarrez-en une nouvelle.",
    );
  }
  return payload as LiveVoiceSessionPayload;
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LIVE_VOICE_GRACE_MS,
  LIVE_VOICE_MAX_EPOCHS,
  LIVE_VOICE_SESSION_MS,
  LiveVoiceSessionError,
  signLiveVoiceSession,
  verifyLiveVoiceSession,
} from "./session-token";

/**
 * Tests du jeton de session Live Voix (Task 110-a) : HMAC-SHA256 sans état.
 * Roundtrip, expiration + grâce de 60 s, plafond d'epochs, jeton falsifié,
 * secret manquant (fail-closed LIVE_UNCONFIGURED).
 */

const SECRET = "secret-de-test-live-voice";
const PARAMS = { uid: "user-1", conversationId: "conv-1" };

function errorCodeOf(error: unknown): string {
  expect(error).toBeInstanceOf(LiveVoiceSessionError);
  return (error as LiveVoiceSessionError).code;
}

beforeEach(() => {
  process.env.LIVE_VOICE_SECRET = SECRET;
  delete process.env.CRON_SECRET;
});

afterEach(() => {
  delete process.env.LIVE_VOICE_SECRET;
  delete process.env.CRON_SECRET;
});

describe("signLiveVoiceSession / verifyLiveVoiceSession", () => {
  it("roundtrip : le jeton signé se vérifie et transporte la charge utile", () => {
    const now = Date.now();
    const { token, payload } = signLiveVoiceSession(PARAMS, now);

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(payload.uid).toBe("user-1");
    expect(payload.conversationId).toBe("conv-1");
    expect(payload.epoch).toBe(1);
    expect(payload.issuedAt).toBe(now);
    expect(payload.exp).toBe(now + LIVE_VOICE_SESSION_MS);
    expect(payload.jti).toHaveLength(36);

    const verified = verifyLiveVoiceSession(token);
    expect(verified).toEqual(payload);
  });

  it("durée de session par défaut : 10 minutes (600 000 ms)", () => {
    expect(LIVE_VOICE_SESSION_MS).toBe(600_000);
    expect(LIVE_VOICE_GRACE_MS).toBe(60_000);
    expect(LIVE_VOICE_MAX_EPOCHS).toBe(6);
  });

  it("grâce de 60 s : un jeton expiré récemment reste vérifiable", () => {
    const now = Date.now();
    const { token } = signLiveVoiceSession(PARAMS, now - LIVE_VOICE_SESSION_MS - 30_000);
    expect(verifyLiveVoiceSession(token).uid).toBe("user-1");
  });

  it("grâce dépassée : jeton expiré depuis plus de 60 s → LIVE_SESSION_EXPIRED", () => {
    const now = Date.now();
    const { token } = signLiveVoiceSession(PARAMS, now - LIVE_VOICE_SESSION_MS - LIVE_VOICE_GRACE_MS - 1_000);
    try {
      verifyLiveVoiceSession(token);
      expect.unreachable("la vérification aurait dû lever");
    } catch (error) {
      expect(errorCodeOf(error)).toBe("LIVE_SESSION_EXPIRED");
    }
  });

  it("allowExpired (route stop) : l'expiration est tolérée, pas la signature", () => {
    const now = Date.now();
    const { token } = signLiveVoiceSession(PARAMS, now - LIVE_VOICE_SESSION_MS - 3_600_000);
    expect(verifyLiveVoiceSession(token, { allowExpired: true }).uid).toBe("user-1");
  });

  it("epoch : un jeton au plafond (6) reste valide", () => {
    const { token, payload } = signLiveVoiceSession({ ...PARAMS, epoch: LIVE_VOICE_MAX_EPOCHS });
    expect(verifyLiveVoiceSession(token).epoch).toBe(LIVE_VOICE_MAX_EPOCHS);
    expect(payload.epoch).toBe(6);
  });

  it("jeton falsifié (charge utile modifiée) → LIVE_SESSION_INVALID", () => {
    const { token } = signLiveVoiceSession(PARAMS);
    const [body, signature] = token.split(".");
    // Retire le dernier caractère du corps puis le remplace : base64url
    // toujours valide, contenu différent, signature désormais fausse.
    const tampered = `${body!.slice(0, -1)}A.${signature}`;
    try {
      verifyLiveVoiceSession(tampered);
      expect.unreachable("la vérification aurait dû lever");
    } catch (error) {
      expect(errorCodeOf(error)).toBe("LIVE_SESSION_INVALID");
    }
  });

  it("signature remplacée → LIVE_SESSION_INVALID", () => {
    const { token } = signLiveVoiceSession(PARAMS);
    const [body] = token.split(".");
    const forged = `${body}.${"A".repeat(43)}`;
    try {
      verifyLiveVoiceSession(forged);
      expect.unreachable("la vérification aurait dû lever");
    } catch (error) {
      expect(errorCodeOf(error)).toBe("LIVE_SESSION_INVALID");
    }
  });

  it("secret changé entre la signature et la vérification → LIVE_SESSION_INVALID", () => {
    const { token } = signLiveVoiceSession(PARAMS);
    process.env.LIVE_VOICE_SECRET = "autre-secret";
    try {
      verifyLiveVoiceSession(token);
      expect.unreachable("la vérification aurait dû lever");
    } catch (error) {
      expect(errorCodeOf(error)).toBe("LIVE_SESSION_INVALID");
    }
  });

  it("jetons mal formés (vide, sans signature, charge illisible) → LIVE_SESSION_INVALID", () => {
    for (const bad of ["", "abc", `a.b`, `${Buffer.from("{pas du json").toString("base64url")}.${"S".repeat(43)}`]) {
      try {
        verifyLiveVoiceSession(bad);
        expect.unreachable(`la vérification de « ${bad} » aurait dû lever`);
      } catch (error) {
        expect(errorCodeOf(error)).toBe("LIVE_SESSION_INVALID");
      }
    }
  });

  it("secret manquant (fail-closed) → LIVE_UNCONFIGURED à la signature ET à la vérification", () => {
    delete process.env.LIVE_VOICE_SECRET;
    delete process.env.CRON_SECRET;

    try {
      signLiveVoiceSession(PARAMS);
      expect.unreachable("la signature aurait dû lever");
    } catch (error) {
      expect(errorCodeOf(error)).toBe("LIVE_UNCONFIGURED");
    }
    try {
      verifyLiveVoiceSession("a.b");
      expect.unreachable("la vérification aurait dû lever");
    } catch (error) {
      expect(errorCodeOf(error)).toBe("LIVE_UNCONFIGURED");
    }
  });

  it("repli CRON_SECRET : le secret de secours signe et vérifie", () => {
    delete process.env.LIVE_VOICE_SECRET;
    process.env.CRON_SECRET = "secret-cron";
    const { token } = signLiveVoiceSession(PARAMS);
    expect(verifyLiveVoiceSession(token).uid).toBe("user-1");
  });
});

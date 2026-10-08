import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";
import {
  LIVE_VOICE_MAX_EPOCHS,
  LIVE_VOICE_SESSION_MS,
  signLiveVoiceSession,
} from "@/lib/live/voice/session-token";

/**
 * Tests de POST /api/live/voice/renew (Task 110-a) : renouvellement epoch+1,
 * grâce stricte (expiré > 60 s → LIVE_SESSION_EXPIRED), plafond d'epochs
 * (403 « Durée maximale atteinte »), jeton d'un autre uid rejeté, garde de
 * solde, authentification 401, audit live.voice_session_renewed.
 */

const verifyFirebaseAuthMock = vi.fn();
const appendAuditMock = vi.fn();
const captureMock = vi.fn();
const getWalletMock = vi.fn();

vi.mock("@/lib/firebase/auth-server", () => ({
  verifyFirebaseAuth: (...args: unknown[]) => verifyFirebaseAuthMock(...args),
}));

vi.mock("@/lib/security/security-audit", () => ({
  appendSecurityAuditEvent: (...args: unknown[]) => appendAuditMock(...args),
}));

vi.mock("@/lib/observability/sentry", () => ({
  captureServerException: (...args: unknown[]) => captureMock(...args),
}));

vi.mock("@/lib/billing/wallet", () => ({
  getWallet: (...args: unknown[]) => getWalletMock(...args),
  reserveFunds: vi.fn(),
  settleReservation: vi.fn(),
  releaseReservation: vi.fn(),
}));

function postRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/live/voice/renew", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LIVE_VOICE_SECRET = "secret-de-test-live-voice";
  verifyFirebaseAuthMock.mockResolvedValue({ uid: "user-1" });
  appendAuditMock.mockResolvedValue("audit-id");
  getWalletMock.mockResolvedValue({
    userId: "user-1",
    currency: "XAF",
    balanceMinor: 100_000,
    reservedMinor: 0,
    availableMinor: 100_000,
    welcomeGranted: true,
    welcomeAmountMinor: 300_000,
  });
});

describe("POST /api/live/voice/renew", () => {
  it("happy path : epoch+1, même conversation, nouveau jeton vérifiable, audit émis", async () => {
    const { token } = signLiveVoiceSession({ uid: "user-1", conversationId: "conv-1", epoch: 1 });
    const response = await POST(postRequest({ token }));
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.epoch).toBe(2);
    expect(data.conversationId).toBe("conv-1");
    expect(data.maxEpochs).toBe(LIVE_VOICE_MAX_EPOCHS);
    expect(data.expiresAt).toBeGreaterThan(Date.now());
    expect(appendAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "live.voice_session_renewed",
        executionId: "conv-1",
        input: expect.objectContaining({ epoch: 2, previousEpoch: 1 }),
      }),
    );
  });

  it("jeton dans la grâce (expiré < 60 s) : renouvellement accepté", async () => {
    const { token } = signLiveVoiceSession(
      { uid: "user-1", conversationId: "conv-1", epoch: 1 },
      Date.now() - LIVE_VOICE_SESSION_MS - 30_000,
    );
    const response = await POST(postRequest({ token }));
    expect(response.status).toBe(200);
  });

  it("jeton expiré depuis plus de 60 s (grâce stricte) → 401 LIVE_SESSION_EXPIRED", async () => {
    const { token } = signLiveVoiceSession(
      { uid: "user-1", conversationId: "conv-1", epoch: 1 },
      Date.now() - LIVE_VOICE_SESSION_MS - 61_000,
    );
    const response = await POST(postRequest({ token }));
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.code).toBe("LIVE_SESSION_EXPIRED");
  });

  it("plafond d'epochs atteint → 403 LIVE_SESSION_INVALID « Durée maximale atteinte »", async () => {
    const { token } = signLiveVoiceSession({
      uid: "user-1",
      conversationId: "conv-1",
      epoch: LIVE_VOICE_MAX_EPOCHS,
    });
    const response = await POST(postRequest({ token }));
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.code).toBe("LIVE_SESSION_INVALID");
    expect(data.error).toBe("Durée maximale atteinte");
    expect(getWalletMock).not.toHaveBeenCalled();
  });

  it("jeton d'un autre utilisateur → 403 LIVE_SESSION_INVALID", async () => {
    const { token } = signLiveVoiceSession({ uid: "user-2", conversationId: "conv-1", epoch: 1 });
    const response = await POST(postRequest({ token }));
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.code).toBe("LIVE_SESSION_INVALID");
  });

  it("authentification manquante → 401", async () => {
    verifyFirebaseAuthMock.mockRejectedValue(new Error("Missing authorization header."));
    const response = await POST(postRequest({ token: "n'importe quoi" }));
    expect(response.status).toBe(401);
  });

  it("solde trop faible → 402 LIVE_INSUFFICIENT_FUNDS", async () => {
    getWalletMock.mockResolvedValue({
      userId: "user-1",
      currency: "XAF",
      balanceMinor: 0,
      reservedMinor: 0,
      availableMinor: 0,
      welcomeGranted: true,
      welcomeAmountMinor: 300_000,
    });
    const { token } = signLiveVoiceSession({ uid: "user-1", conversationId: "conv-1", epoch: 1 });
    const response = await POST(postRequest({ token }));
    expect(response.status).toBe(402);
    const data = await response.json();
    expect(data.code).toBe("LIVE_INSUFFICIENT_FUNDS");
  });

  it("corps invalide (token absent) → 422 lisible", async () => {
    const response = await POST(postRequest({}));
    expect(response.status).toBe(422);
  });
});

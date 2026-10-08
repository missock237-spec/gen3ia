import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";
import { verifyLiveVoiceSession } from "@/lib/live/voice/session-token";

/**
 * Tests de POST /api/live/voice/session (Task 110-a) : garde PC (403),
 * authentification (401), rate limit (429), garde de solde (402), création
 * de conversation dédiée ou reprise d'un fil existant (ownership), jeton
 * epoch 1 vérifiable, audit live.voice_session_started.
 *
 * Le jeton de session (HMAC réel) est testé avec LIVE_VOICE_SECRET posé dans
 * l'environnement — le module lit le secret à chaque appel.
 */

const verifyFirebaseAuthMock = vi.fn();
const enforceRateLimitMock = vi.fn();
const appendAuditMock = vi.fn();
const captureMock = vi.fn();
const getWalletMock = vi.fn();
const createConversationMock = vi.fn();
const getConversationMock = vi.fn();

vi.mock("@/lib/firebase/auth-server", () => ({
  verifyFirebaseAuth: (...args: unknown[]) => verifyFirebaseAuthMock(...args),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) => enforceRateLimitMock(...args),
}));

vi.mock("@/lib/security/security-audit", () => ({
  appendSecurityAuditEvent: (...args: unknown[]) => appendAuditMock(...args),
}));

vi.mock("@/lib/observability/sentry", () => ({
  captureServerException: (...args: unknown[]) => captureMock(...args),
}));

// media-meter (chargé par lib/live/voice/cost.ts) importe ces 4 exports.
vi.mock("@/lib/billing/wallet", () => ({
  getWallet: (...args: unknown[]) => getWalletMock(...args),
  reserveFunds: vi.fn(),
  settleReservation: vi.fn(),
  releaseReservation: vi.fn(),
}));

vi.mock("@/lib/chat/repository", () => ({
  createConversation: (...args: unknown[]) => createConversationMock(...args),
  getConversation: (...args: unknown[]) => getConversationMock(...args),
}));

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function postRequest(body: unknown, userAgent = DESKTOP_UA): Request {
  return new Request("http://localhost:3000/api/live/voice/session", {
    method: "POST",
    headers: { "user-agent": userAgent, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LIVE_VOICE_SECRET = "secret-de-test-live-voice";
  verifyFirebaseAuthMock.mockResolvedValue({ uid: "user-1" });
  enforceRateLimitMock.mockResolvedValue({ allowed: true, remaining: 9, retryAfterMs: 0, distributed: false });
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
  createConversationMock.mockResolvedValue({ id: "conv-new", userId: "user-1", title: "Session Live Voix" });
  getConversationMock.mockResolvedValue({ id: "conv-1", userId: "user-1", title: "Fil existant" });
});

describe("POST /api/live/voice/session", () => {
  it("happy path : 201, jeton epoch 1 vérifiable, fil créé, audit émis", async () => {
    const response = await POST(postRequest({}));
    expect(response.status).toBe(201);
    const data = await response.json();

    expect(data.epoch).toBe(1);
    expect(data.maxEpochs).toBe(6);
    expect(data.conversationId).toBe("conv-new");
    expect(data.expiresAt).toBeGreaterThan(Date.now());
    expect(verifyLiveVoiceSession(data.token)).toMatchObject({
      uid: "user-1",
      conversationId: "conv-new",
      epoch: 1,
    });

    expect(createConversationMock).toHaveBeenCalledWith("user-1", expect.stringMatching(/^Session Live Voix — /));
    expect(appendAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", toolName: "live.voice_session_started", executionId: "conv-new" }),
    );
  });

  it("conversationId fourni : fil existant repris, aucune création", async () => {
    const response = await POST(postRequest({ conversationId: "conv-1" }));
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.conversationId).toBe("conv-1");
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(getConversationMock).toHaveBeenCalledWith("user-1", "conv-1");
  });

  it("conversation d'un autre utilisateur → 404 (ownership)", async () => {
    getConversationMock.mockResolvedValue(null);
    const response = await POST(postRequest({ conversationId: "conv-inconnu" }));
    expect(response.status).toBe(404);
    expect(createConversationMock).not.toHaveBeenCalled();
  });

  it("garde PC : navigateur mobile → 403 code LIVE_PC_ONLY, aucune authentification", async () => {
    const response = await POST(postRequest({}, MOBILE_UA));
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.code).toBe("LIVE_PC_ONLY");
    expect(verifyFirebaseAuthMock).not.toHaveBeenCalled();
  });

  it("authentification manquante → 401", async () => {
    verifyFirebaseAuthMock.mockRejectedValue(new Error("Missing authorization header."));
    const response = await POST(postRequest({}));
    expect(response.status).toBe(401);
    expect(getWalletMock).not.toHaveBeenCalled();
  });

  it("rate limit dépassé → 429 code LIVE_RATE_LIMITED", async () => {
    enforceRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 60_000, distributed: true });
    const response = await POST(postRequest({}));
    expect(response.status).toBe(429);
    const data = await response.json();
    expect(data.code).toBe("LIVE_RATE_LIMITED");
  });

  it("solde trop faible → 402 code LIVE_INSUFFICIENT_FUNDS", async () => {
    getWalletMock.mockResolvedValue({
      userId: "user-1",
      currency: "XAF",
      balanceMinor: 10,
      reservedMinor: 0,
      availableMinor: 10,
      welcomeGranted: true,
      welcomeAmountMinor: 300_000,
    });
    const response = await POST(postRequest({}));
    expect(response.status).toBe(402);
    const data = await response.json();
    expect(data.code).toBe("LIVE_INSUFFICIENT_FUNDS");
    expect(createConversationMock).not.toHaveBeenCalled();
  });

  it("secret de signature manquant → 503 code LIVE_UNCONFIGURED", async () => {
    delete process.env.LIVE_VOICE_SECRET;
    delete process.env.CRON_SECRET;
    const response = await POST(postRequest({}));
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.code).toBe("LIVE_UNCONFIGURED");
  });

  it("corps invalide (conversationId non chaîne) → 422 via errorStatus", async () => {
    const response = await POST(postRequest({ conversationId: 42 }));
    expect([400, 422]).toContain(response.status);
    expect(createConversationMock).not.toHaveBeenCalled();
  });
});

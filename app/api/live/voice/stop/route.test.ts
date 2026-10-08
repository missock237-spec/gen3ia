import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";
import { signLiveVoiceSession } from "@/lib/live/voice/session-token";

/**
 * Tests de POST /api/live/voice/stop (Task 110-a) : clôture souple (jeton
 * expiré accepté), audit live.voice_session_stopped avec durée, 204 sans
 * contenu, jeton invalide → 403.
 */

const appendAuditMock = vi.fn();
const captureMock = vi.fn();

vi.mock("@/lib/security/security-audit", () => ({
  appendSecurityAuditEvent: (...args: unknown[]) => appendAuditMock(...args),
}));

vi.mock("@/lib/observability/sentry", () => ({
  captureServerException: (...args: unknown[]) => captureMock(...args),
}));

function postRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/live/voice/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LIVE_VOICE_SECRET = "secret-de-test-live-voice";
  appendAuditMock.mockResolvedValue("audit-id");
});

describe("POST /api/live/voice/stop", () => {
  it("session active : 204 sans contenu + audit avec epoch et durée", async () => {
    const issuedAt = Date.now() - 65_000;
    const { token } = signLiveVoiceSession({ uid: "user-1", conversationId: "conv-1", epoch: 2 }, issuedAt);
    const response = await POST(postRequest({ token }));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(appendAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        toolName: "live.voice_session_stopped",
        executionId: "conv-1",
        input: expect.objectContaining({ epoch: 2 }),
      }),
    );
    const input = appendAuditMock.mock.calls[0]![0] as { input: { durationSec: number } };
    expect(input.input.durationSec).toBeGreaterThanOrEqual(60);
  });

  it("jeton expiré depuis longtemps : clôture SOUPLE acceptée (204)", async () => {
    const { token } = signLiveVoiceSession(
      { uid: "user-1", conversationId: "conv-1", epoch: 1 },
      Date.now() - 600_000 - 3_600_000,
    );
    const response = await POST(postRequest({ token }));
    expect(response.status).toBe(204);
    expect(appendAuditMock).toHaveBeenCalledTimes(1);
  });

  it("jeton invalide → 403 code LIVE_SESSION_INVALID", async () => {
    const response = await POST(postRequest({ token: "n'importe quoi.falsifié" }));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("LIVE_SESSION_INVALID");
    expect(appendAuditMock).not.toHaveBeenCalled();
  });

  it("corps invalide (token absent) → 422", async () => {
    const response = await POST(postRequest({}));
    expect(response.status).toBe(422);
  });
});

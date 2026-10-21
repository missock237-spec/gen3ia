import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

/**
 * Boucle Live du mode navigateur — POST /frames (décision) et PUT /frames
 * (résultat d'action). Restauration post-Task 150.
 *
 * Verrous :
 *  - garde PC-only, auth, quota de frames, session propriétaire + device ;
 *  - dédup « écran inchangé » : réponse immédiate sans nouvelle décision ;
 *  - verrou « une décision en vol par session » (409 sinon) ;
 *  - le résultat d'action alimente le runtime (reprise de boucle).
 */

vi.mock("@/lib/firebase/auth-server", () => ({
  verifyFirebaseAuth: vi.fn(),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  enforceRateLimit: vi.fn(),
}));
vi.mock("@/lib/observability/sentry", () => ({
  captureServerException: vi.fn(),
}));
vi.mock("@/lib/live/repository", () => ({
  assertLiveSessionOwner: vi.fn(),
  beginLiveAction: vi.fn(),
  claimApprovedLiveAction: vi.fn(),
  completeLiveAction: vi.fn(),
  recordLiveEvent: vi.fn(),
  recordLiveObservation: vi.fn(),
  recordLiveRuntimeActionResult: vi.fn(),
  setPendingLiveAction: vi.fn(),
  updateLiveSessionStatus: vi.fn(),
}));
vi.mock("@/lib/live/vision-decider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/live/vision-decider")>()),
  decideLiveAction: vi.fn(),
}));

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import {
  assertLiveSessionOwner,
  beginLiveAction,
  claimApprovedLiveAction,
  completeLiveAction,
  recordLiveEvent,
  recordLiveObservation,
  recordLiveRuntimeActionResult,
} from "@/lib/live/repository";
import { decideLiveAction } from "@/lib/live/vision-decider";
import {
  acquireDecisionLock,
  releaseDecisionLock,
  resetDecisionLockForTests,
  setFramePrint,
} from "@/lib/live/decision-lock";
import { DELETE, GET as GET_SESSION, POST as POST_SESSION } from "../route";
import { POST as POST_FRAMES, PUT as PUT_FRAMES } from "./route";

const mockedAuth = vi.mocked(verifyFirebaseAuth);
const mockedLimit = vi.mocked(enforceRateLimit);
const mockedOwner = vi.mocked(assertLiveSessionOwner);
const mockedClaim = vi.mocked(claimApprovedLiveAction);
const mockedObservation = vi.mocked(recordLiveObservation);
const mockedEvent = vi.mocked(recordLiveEvent);
const mockedBegin = vi.mocked(beginLiveAction);
const mockedComplete = vi.mocked(completeLiveAction);
const mockedResult = vi.mocked(recordLiveRuntimeActionResult);
const mockedDecide = vi.mocked(decideLiveAction);

const SESSION_ID = "live_frames_test";
const DEVICE_ID = "web-test-device";
/** UUID v4 valide (variante RFC 4122) — zod v4 refuse la variante non conforme. */
const ACTION_ID = "9c0d1e2f-3a4b-4c6d-8e8f-0a1b2c3d4e5f";
const PC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const JPEG_BASE64 = Buffer.from("frame-pixels-r1").toString("base64");

function sessionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    ownerId: "user-1",
    name: "Test",
    objective: "Vérifier l'écran",
    status: "running",
    permissions: ["screen.read"],
    deviceId: DEVICE_ID,
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
    version: 1,
    expiresAt: Date.now() + 60_000,
    mode: "browser",
    runtime: { status: "running", iteration: 1, maxIterations: 300 },
    ...overrides,
  };
}

function postFrame(body: unknown, userAgent = PC_UA) {
  return new NextRequest(`http://localhost/api/live/sessions/${SESSION_ID}/frames`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify(body),
  });
}

function frameBody(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: DEVICE_ID,
    timestamp: Date.now(),
    width: 800,
    height: 500,
    jpegBase64: JPEG_BASE64,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDecisionLockForTests();
  mockedAuth.mockResolvedValue({ uid: "user-1" } as never);
  mockedLimit.mockResolvedValue({ allowed: true } as never);
  mockedOwner.mockResolvedValue(sessionFixture() as never);
  mockedClaim.mockResolvedValue(null as never);
  mockedObservation.mockResolvedValue({ status: "running", iteration: 2, maxIterations: 300 } as never);
  mockedEvent.mockResolvedValue(undefined as never);
  mockedBegin.mockResolvedValue(undefined as never);
  mockedComplete.mockResolvedValue(undefined as never);
  mockedResult.mockResolvedValue(undefined as never);
});

describe("POST /api/live/sessions/[id]/frames", () => {
  it("refuse les appareils non PC", async () => {
    const response = await POST_FRAMES(
      postFrame(frameBody(), "Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 Mobile Safari/537.36"),
      { params: Promise.resolve({ id: SESSION_ID }) },
    );
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("LIVE_PC_ONLY");
  });

  it("exige une authentification", async () => {
    mockedAuth.mockRejectedValueOnce(new Error("authorization header missing"));
    const response = await POST_FRAMES(postFrame(frameBody()), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(response.status).toBe(401);
  });

  it("refuse une session arrêtée (409)", async () => {
    mockedOwner.mockResolvedValueOnce(sessionFixture({ status: "stopped" }) as never);
    const response = await POST_FRAMES(postFrame(frameBody()), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("LIVE_STOPPED");
  });

  it("refuse un device non autorisé (401)", async () => {
    const response = await POST_FRAMES(postFrame(frameBody({ deviceId: "web-other" })), {
      params: Promise.resolve({ id: SESSION_ID }),
    });
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("LIVE_DEVICE_MISMATCH");
  });

  it("répond `unchanged` sans nouvelle décision pour une frame identique (dédup)", async () => {
    const hash = createHash("sha256").update(JPEG_BASE64).digest("hex");
    await setFramePrint(SESSION_ID, { hash, feedbackAt: 0 });
    const response = await POST_FRAMES(postFrame(frameBody()), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.unchanged).toBe(true);
    expect(mockedDecide).not.toHaveBeenCalled();
    expect(mockedObservation).not.toHaveBeenCalled();
  });

  it("retourne 409 LIVE_DECISION_IN_FLIGHT quand une décision est déjà en vol", async () => {
    const lock = await acquireDecisionLock(SESSION_ID);
    expect(lock.acquired).toBe(true);
    const response = await POST_FRAMES(postFrame(frameBody()), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("LIVE_DECISION_IN_FLIGHT");
    await releaseDecisionLock(SESSION_ID);
  });

  it("décision avec action `wait` : observation tracée, action confiée au client", async () => {
    mockedDecide.mockResolvedValueOnce({
      done: false,
      message: "Attendez l'ouverture de la fenêtre.",
      action: { type: "wait", ms: 2000 },
      perception: "structural-guided",
    });
    const response = await POST_FRAMES(postFrame(frameBody()), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.decision.message).toContain("fenêtre");
    expect(data.perception).toBe("structural-guided");
    expect(data.action.action.type).toBe("wait");
    expect(mockedObservation).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ deviceId: DEVICE_ID, done: false }),
    );
    expect(mockedEvent).toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({ type: "vision.decision" }));
    expect(mockedBegin).toHaveBeenCalledWith(SESSION_ID, expect.any(String), { type: "wait", ms: 2000 }, DEVICE_ID);
  });

  it("décision sans action : aucune action débutée", async () => {
    mockedDecide.mockResolvedValueOnce({
      done: false,
      message: "Observation structurelle en cours.",
      action: null,
      perception: "structural-degraded",
    });
    const response = await POST_FRAMES(postFrame(frameBody()), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.action).toBeUndefined();
    expect(mockedBegin).not.toHaveBeenCalled();
  });

  it("action approuvée en attente : dispatch sans consommer de décision", async () => {
    mockedClaim.mockResolvedValueOnce({
      actionId: ACTION_ID,
      action: { type: "wait", ms: 1000 },
      createdAt: Date.now(),
      approvedAt: Date.now(),
    } as never);
    const response = await POST_FRAMES(postFrame(frameBody()), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.decision).toBeNull();
    expect(data.action.actionId).toBe(ACTION_ID);
    expect(mockedDecide).not.toHaveBeenCalled();
  });
});

describe("PUT /api/live/sessions/[id]/frames (résultat d'action)", () => {
  it("enregistre le résultat et libère l'action en vol", async () => {
    const response = await PUT_FRAMES(
      new NextRequest(`http://localhost/api/live/sessions/${SESSION_ID}/frames`, {
        method: "PUT",
        headers: { "content-type": "application/json", "user-agent": PC_UA },
        body: JSON.stringify({
          deviceId: DEVICE_ID,
          actionId: ACTION_ID,
          ok: true,
        }),
      }),
      { params: Promise.resolve({ id: SESSION_ID }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(mockedComplete).toHaveBeenCalledWith(SESSION_ID, ACTION_ID, DEVICE_ID);
    expect(mockedResult).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ deviceId: DEVICE_ID, ok: true }),
    );
    expect(mockedEvent).toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({ type: "action.result", ok: true }));
  });

  it("refuse un device non autorisé (401)", async () => {
    const response = await PUT_FRAMES(
      new NextRequest(`http://localhost/api/live/sessions/${SESSION_ID}/frames`, {
        method: "PUT",
        headers: { "content-type": "application/json", "user-agent": PC_UA },
        body: JSON.stringify({
          deviceId: "web-other",
          actionId: ACTION_ID,
          ok: false,
        }),
      }),
      { params: Promise.resolve({ id: SESSION_ID }) },
    );
    expect(response.status).toBe(401);
  });
});

describe("GET et POST /api/live/sessions/[id] (état / pause / reprise / arrêt)", () => {
  it("GET renvoie la session sans les hashes de tokens", async () => {
    mockedOwner.mockResolvedValueOnce({ ...sessionFixture(), pairingTokenHash: "h", viewerTokenHash: "v" } as never);
    const response = await GET_SESSION(new NextRequest(`http://localhost/api/live/sessions/${SESSION_ID}`, { headers: { "user-agent": PC_UA } }), {
      params: Promise.resolve({ id: SESSION_ID }),
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.session.id).toBe(SESSION_ID);
    expect(data.session.pairingTokenHash).toBeUndefined();
    expect(data.session.viewerTokenHash).toBeUndefined();
  });

  it("POST stop passe la session en stopped", async () => {
    const { updateLiveSessionStatus } = await import("@/lib/live/repository");
    const response = await POST_SESSION(
      new NextRequest(`http://localhost/api/live/sessions/${SESSION_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": PC_UA },
        body: JSON.stringify({ action: "stop" }),
      }),
      { params: Promise.resolve({ id: SESSION_ID }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("stopped");
    expect(vi.mocked(updateLiveSessionStatus)).toHaveBeenCalledWith(SESSION_ID, "stopped");
  });

  it("DELETE arrête la session", async () => {
    const { updateLiveSessionStatus } = await import("@/lib/live/repository");
    const response = await DELETE(
      new NextRequest(`http://localhost/api/live/sessions/${SESSION_ID}`, { method: "DELETE", headers: { "user-agent": PC_UA } }),
      { params: Promise.resolve({ id: SESSION_ID }) },
    );
    expect(response.status).toBe(200);
    expect(vi.mocked(updateLiveSessionStatus)).toHaveBeenCalledWith(SESSION_ID, "stopped");
  });
});

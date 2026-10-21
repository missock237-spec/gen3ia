import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Routes /api/live/sessions — création et liste des sessions de l'agent Live.
 * Restauration post-Task 150 : le module est de retour, propulsé par le
 * moteur neural interne. Verrous : garde PC-only, authentification, rate
 * limit, tokens d'appairage jamais stockés en clair, isolation propriétaire.
 */

vi.mock("@/lib/firebase/auth-server", () => ({
  verifyFirebaseAuth: vi.fn(),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  enforceRateLimit: vi.fn(),
}));
vi.mock("@/lib/security/security-audit", () => ({
  appendSecurityAuditEvent: vi.fn(),
}));
vi.mock("@/lib/observability/sentry", () => ({
  captureServerException: vi.fn(),
}));
vi.mock("@/lib/live/repository", () => ({
  createLiveSession: vi.fn(),
  listLiveSessions: vi.fn(),
}));

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { appendSecurityAuditEvent } from "@/lib/security/security-audit";
import { createLiveSession, listLiveSessions } from "@/lib/live/repository";
import { GET, POST } from "./route";

const mockedAuth = vi.mocked(verifyFirebaseAuth);
const mockedLimit = vi.mocked(enforceRateLimit);
const mockedAudit = vi.mocked(appendSecurityAuditEvent);
const mockedCreate = vi.mocked(createLiveSession);
const mockedList = vi.mocked(listLiveSessions);

const PC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function postRequest(body: unknown, userAgent = PC_UA) {
  return new NextRequest("http://localhost/api/live/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify(body),
  });
}

function getRequest(userAgent = PC_UA) {
  return new NextRequest("http://localhost/api/live/sessions", {
    method: "GET",
    headers: { "user-agent": userAgent },
  });
}

const SESSION = {
  id: "live_abc",
  ownerId: "user-1",
  name: "Présentation",
  objective: "Vérifier l'écran",
  status: "pending",
  permissions: ["screen.read"],
  createdAt: 1,
  updatedAt: 1,
  version: 1,
  runtime: { status: "idle", iteration: 0, maxIterations: 300 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedAuth.mockResolvedValue({ uid: "user-1" } as never);
  mockedLimit.mockResolvedValue({ allowed: true } as never);
  mockedAudit.mockResolvedValue(undefined as never);
  mockedCreate.mockResolvedValue(SESSION as never);
  mockedList.mockResolvedValue([SESSION] as never);
});

describe("POST /api/live/sessions", () => {
  it("refuse les appareils non PC (garde serveur isLiveCapable)", async () => {
    const response = await POST(postRequest({ name: "x", objective: "y".repeat(12), permissions: ["screen.read"] }, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"));
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.code).toBe("LIVE_PC_ONLY");
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("exige une authentification valide", async () => {
    mockedAuth.mockRejectedValueOnce(new Error("authorization header missing"));
    const response = await POST(postRequest({ name: "x", objective: "y".repeat(12), permissions: ["screen.read"] }));
    expect(response.status).toBe(401);
  });

  it("refuse au-delà du quota de sessions (rate limit)", async () => {
    mockedLimit.mockResolvedValueOnce({ allowed: false } as never);
    const response = await POST(postRequest({ name: "x", objective: "y".repeat(12), permissions: ["screen.read"] }));
    expect(response.status).toBe(429);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("valide le corps (permissions connues, objective non vide)", async () => {
    const response = await POST(postRequest({ name: "x", objective: "", permissions: ["screen.read"] }));
    // ZodError → 422 (convention lib/security/http-errors), pas 400.
    expect(response.status).toBe(422);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("crée une session : tokens d'appairage retournés, hash et audit côté serveur", async () => {
    const response = await POST(
      postRequest({ name: "Présentation", objective: "Vérifier l'avancement à l'écran", permissions: ["screen.read"], mode: "browser" }),
    );
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.session.id).toBe("live_abc");
    expect(data.pairingToken).toBeTruthy();
    expect(data.viewerToken).toBeTruthy();

    const createInput = mockedCreate.mock.calls[0]![0]!;
    expect(createInput.ownerId).toBe("user-1");
    expect(createInput.pairingTokenHash).not.toBe(data.pairingToken);
    expect(createInput.pairingTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(createInput.mode).toBe("browser");
    expect(mockedAudit).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/live/sessions", () => {
  it("liste uniquement les sessions du propriétaire authentifié", async () => {
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.sessions).toHaveLength(1);
    expect(mockedList).toHaveBeenCalledWith("user-1");
  });

  it("retourne 401 en cas de jeton invalide", async () => {
    mockedAuth.mockRejectedValueOnce(new Error("revoked token"));
    const response = await GET(getRequest());
    expect(response.status).toBe(401);
  });
});

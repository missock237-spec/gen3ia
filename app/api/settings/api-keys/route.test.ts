import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { HttpError } from "@/lib/security/http-errors";

/**
 * Route self-service /api/settings/api-keys (Task 126) — contrat HTTP :
 * session obligatoire (protectRoute), création validée par zod (la clé
 * complète n'est renvoyée QU'UNE fois en 201), révocation par identifiant,
 * journalisation `auditEvents` sur création et révocation.
 */

const protectMock = vi.fn();
const createMock = vi.fn();
const listMock = vi.fn();
const revokeMock = vi.fn();
const auditMock = vi.fn();

vi.mock("@/lib/security/route-guard", () => ({
  protectRoute: (...args: unknown[]) => protectMock(...args),
}));

vi.mock("@/lib/security/audit-events", () => ({
  recordAuditEventSafe: (...args: unknown[]) => auditMock(...args),
}));

vi.mock("@/lib/security/api-keys", () => ({
  API_KEY_SCOPES: ["media", "agents", "terminal", "read"],
  createApiKey: (...args: unknown[]) => createMock(...args),
  listApiKeys: (...args: unknown[]) => listMock(...args),
  revokeApiKey: (...args: unknown[]) => revokeMock(...args),
}));

import { GET, POST, DELETE } from "./route";

const CONTEXT = { userId: "user-1", email: "u@gen3ia.io", traceId: "t1" };

function ok() {
  return { ok: true as const, context: CONTEXT };
}

function denied(status: number) {
  return { ok: false as const, response: new Response(JSON.stringify({ error: "non" }), { status }) };
}

function request(method: string, body?: unknown): NextRequest {
  return new NextRequest("https://gen3ia.local/api/settings/api-keys", {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  auditMock.mockReturnValue(undefined);
});

describe("GET /api/settings/api-keys", () => {
  it("liste les clés du compte authentifié", async () => {
    protectMock.mockResolvedValue(ok());
    listMock.mockResolvedValue([{ id: "h1", name: "n8n", prefix: "g3a_Ab12Cd" }]);
    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { keys: unknown[] };
    expect(body.keys).toHaveLength(1);
    expect(listMock).toHaveBeenCalledWith("user-1");
  });

  it("refuse sans session (401 du garde)", async () => {
    protectMock.mockResolvedValue(denied(401));
    const response = await GET(request("GET"));
    expect(response.status).toBe(401);
  });
});

describe("POST /api/settings/api-keys", () => {
  it("crée une clé : 201, clé affichée une seule fois + audit", async () => {
    protectMock.mockResolvedValue(ok());
    createMock.mockResolvedValue({
      key: "g3a_cleDeTestAfficheeUneFois",
      view: { id: "h2", name: "prod", prefix: "g3a_Xy98Zw", scopes: ["agents"], rateLimitPerMinute: 60 },
    });
    const response = await POST(request("POST", { name: "prod", scopes: ["agents"] }));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { key: string; warning: string };
    expect(body.key).toBe("g3a_cleDeTestAfficheeUneFois");
    expect(body.warning).toMatch(/jamais/);
    expect(createMock).toHaveBeenCalledWith({ ownerId: "user-1", name: "prod", scopes: ["agents"], rateLimitPerMinute: undefined });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "apikey.create", actorId: "user-1" }));
  });

  it("rejette un payload invalide (400) sans créer ni auditer", async () => {
    protectMock.mockResolvedValue(ok());
    const response = await POST(request("POST", { name: "", scopes: [] }));
    expect(response.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("propage le conflit de plafond de clés (409)", async () => {
    protectMock.mockResolvedValue(ok());
    createMock.mockRejectedValue(new HttpError(409, "Maximum de 10 clés actives atteint."));
    const response = await POST(request("POST", { name: "k", scopes: ["read"] }));
    expect(response.status).toBe(409);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/settings/api-keys", () => {
  it("révoque par identifiant et journalise", async () => {
    protectMock.mockResolvedValue(ok());
    revokeMock.mockResolvedValue({ id: "h2", prefix: "g3a_Xy98Zw", revokedAt: 1 });
    const response = await DELETE(request("DELETE", { id: "h2" }));
    expect(response.status).toBe(200);
    expect(revokeMock).toHaveBeenCalledWith("user-1", "h2");
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "apikey.revoke", outcome: "completed" }));
  });

  it("404 si la clé n'appartient pas au compte", async () => {
    protectMock.mockResolvedValue(ok());
    revokeMock.mockRejectedValue(new HttpError(404, "Clé API introuvable pour ce compte."));
    const response = await DELETE(request("DELETE", { id: "autre" }));
    expect(response.status).toBe(404);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Route /api/agents/[id]/analytics (Task 131) — contrat HTTP :
 * session obligatoire (protectRoute), query ?days validée par zod (défaut 7,
 * max 90), propriété de l'agent vérifiée comme les autres routes agents
 * (404 si introuvable, 403 s'il existe sans être accessible), métriques
 * agrégées + série quotidienne dans la réponse.
 */

const protectMock = vi.fn();
const getAgentForUserMock = vi.fn();
const getAgentByIdMock = vi.fn();
const getAnalyticsMock = vi.fn();

vi.mock("@/lib/security/route-guard", () => ({
  protectRoute: (...args: unknown[]) => protectMock(...args),
}));

vi.mock("@/lib/agents/repository", () => ({
  getAgentForUser: (...args: unknown[]) => getAgentForUserMock(...args),
  getAgentById: (...args: unknown[]) => getAgentByIdMock(...args),
}));

vi.mock("@/lib/agents/analytics", () => ({
  getAgentAnalytics: (...args: unknown[]) => getAnalyticsMock(...args),
}));

import { GET } from "./route";

const CONTEXT = { userId: "user-1", email: "u@gen3ia.io", traceId: "t1" };

function ok() {
  return { ok: true as const, context: CONTEXT };
}

function denied(status: number) {
  return { ok: false as const, response: new Response(JSON.stringify({ error: "non" }), { status }) };
}

function request(query = ""): NextRequest {
  return new NextRequest(`https://gen3ia.local/api/agents/agent-1/analytics${query}`, {
    method: "GET",
  });
}

const ROUTE_CONTEXT = { params: Promise.resolve({ id: "agent-1" }) };

const AGENT = {
  id: "agent-1",
  ownerId: "user-1",
  name: "Agent commercial",
  status: "active",
};

const SUMMARY = {
  agentId: "agent-1",
  days: 7,
  messages: 12,
  toolCalls: 9,
  errors: 1,
  tokensIn: 4_800,
  tokensOut: 2_100,
  latency: { samples: 12, avgMs: 1_800, p50Ms: 1_500, p95Ms: 3_900 },
  daily: [{ dayIso: "2026-03-09", messages: 3, toolCalls: 2, errors: 0, tokensIn: 1_000, tokensOut: 500, latencyAvgMs: 1_200 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  protectMock.mockResolvedValue(ok());
  getAgentForUserMock.mockResolvedValue(AGENT);
  getAnalyticsMock.mockResolvedValue(SUMMARY);
});

describe("GET /api/agents/[id]/analytics", () => {
  it("renvoie les métriques agrégées de l'agent (défaut 7 jours)", async () => {
    const response = await GET(request(), ROUTE_CONTEXT);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { agentId: string; days: number; analytics: typeof SUMMARY };
    expect(body.agentId).toBe("agent-1");
    expect(body.days).toBe(7);
    expect(body.analytics.latency.p95Ms).toBe(3_900);
    expect(body.analytics.daily).toHaveLength(1);
    expect(getAgentForUserMock).toHaveBeenCalledWith("user-1", "agent-1");
    expect(getAnalyticsMock).toHaveBeenCalledWith("agent-1", 7);
  });

  it("accepte ?days=30 et le transmet à la couche analytics", async () => {
    const response = await GET(request("?days=30"), ROUTE_CONTEXT);
    expect(response.status).toBe(200);
    expect(getAnalyticsMock).toHaveBeenCalledWith("agent-1", 30);
    const body = (await response.json()) as { days: number };
    expect(body.days).toBe(30);
  });

  it("rejette un paramètre days invalide (400) sans toucher à la persistance", async () => {
    const response = await GET(request("?days=91"), ROUTE_CONTEXT);
    expect(response.status).toBe(400);
    expect(getAnalyticsMock).not.toHaveBeenCalled();
    const responseText = await GET(request("?days=abc"), ROUTE_CONTEXT);
    expect(responseText.status).toBe(400);
  });

  it("refuse sans session (401 du garde)", async () => {
    protectMock.mockResolvedValue(denied(401));
    const response = await GET(request(), ROUTE_CONTEXT);
    expect(response.status).toBe(401);
    expect(getAnalyticsMock).not.toHaveBeenCalled();
  });

  it("404 quand l'agent est introuvable", async () => {
    getAgentForUserMock.mockResolvedValue(null);
    getAgentByIdMock.mockResolvedValue(null);
    const response = await GET(request(), ROUTE_CONTEXT);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("introuvable");
  });

  it("403 quand l'agent existe mais n'appartient pas à l'utilisateur", async () => {
    getAgentForUserMock.mockResolvedValue(null);
    getAgentByIdMock.mockResolvedValue({ ...AGENT, ownerId: "user-2" });
    const response = await GET(request(), ROUTE_CONTEXT);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("accessible");
    expect(getAnalyticsMock).not.toHaveBeenCalled();
  });

  it("propage la panne de persistance en 503 (format d'erreur standard)", async () => {
    getAnalyticsMock.mockRejectedValue(new Error("agent analytics read: aucune réponse en 6000ms (probablement quota Firestore épuisé)."));
    const response = await GET(request(), ROUTE_CONTEXT);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("PROVIDER_UNAVAILABLE");
  });
});

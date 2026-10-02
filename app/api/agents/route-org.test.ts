import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Routes /api/agents — surface org-aware (recommandation C) : la liste est
 * l'union personnel + organisations ; la création transmet l'orgId optionnel
 * au dépôt (la validation d'appartenance est dans la politique centralisée,
 * mockée ici) ; le détail reste en 404 anti-énumération si l'accès est refusé.
 */

const { mockedRequireUser, mockedListForUser, mockedCreateRecord, mockedGetForUser, mockedProjectOk } = vi.hoisted(() => ({
  mockedRequireUser: vi.fn(),
  mockedListForUser: vi.fn(),
  mockedCreateRecord: vi.fn(),
  mockedGetForUser: vi.fn(),
  mockedProjectOk: vi.fn(),
}));

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: (...args: unknown[]) => mockedRequireUser(...args) }));
vi.mock("@/lib/agents/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/repository")>();
  return {
    ...actual,
    listAgentsForUser: (...args: unknown[]) => mockedListForUser(...args),
    createAgentRecord: (...args: unknown[]) => mockedCreateRecord(...args),
    getAgentForUser: (...args: unknown[]) => mockedGetForUser(...args),
  };
});
vi.mock("@/lib/agents/tool-resolver", () => ({
  resolveAndHarden: vi.fn(() => ({ resolution: { resolved: [], unknown: [], mapping: [] }, hardening: { mode: "always_ask", hardened: false }, report: { notes: [] } })),
}));
vi.mock("@/lib/developer/projects", () => ({
  getDeveloperProject: (...args: unknown[]) => mockedProjectOk(...args),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  enforceRateLimit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

import { GET, POST } from "./route";
import { ResourceAccessError } from "@/lib/tenants/resource-access";
import type { AgentRecord } from "@/lib/agents/schema";

function agentSummary(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1", ownerId: "u1", name: "Agent", description: "", type: "universal", typeLabel: undefined,
    skills: [], agentMode: "standard", memoryFile: undefined, projectId: undefined, orgId: undefined,
    systemPrompt: "x", modelStrategy: "automatic", preferredProvider: undefined, preferredModel: undefined,
    autonomous: true, subagentsEnabled: true, maxSubagents: 3, subAgentIds: [], temperature: 0.7,
    mcpEnabled: true, authorizationMode: "always_ask", budgetEurMinor: undefined, maxIterations: 8,
    tools: [], memoryEnabled: true, webResearchEnabled: true, documentGenerationEnabled: true,
    voiceEnabled: false, voiceConfig: undefined, persona: undefined, status: "active",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides,
  } as AgentRecord;
}

function request(url: string, init?: RequestInit) {
  return new NextRequest(`http://localhost${url}`, init);
}

beforeEach(() => {
  mockedProjectOk.mockReset().mockResolvedValue(false);
  mockedRequireUser.mockReset().mockResolvedValue({ uid: "u1" });
  mockedListForUser.mockReset().mockResolvedValue([]);
  mockedCreateRecord.mockReset().mockResolvedValue(agentSummary());
  mockedGetForUser.mockReset().mockResolvedValue(null);
});

describe("GET /api/agents — liste union", () => {
  it("délègue à listAgentsForUser (et non à la liste propriétaire stricte)", async () => {
    mockedListForUser.mockResolvedValue([agentSummary()]);
    const response = await GET(request("/api/agents"));
    expect(response.status).toBe(200);
    expect(mockedListForUser).toHaveBeenCalledWith("u1", undefined);
    const body = await response.json();
    expect(body.agents).toHaveLength(1);
  });

  it("propage le filtre projectId (projet validé au préalable)", async () => {
    mockedProjectOk.mockResolvedValue(true);
    await GET(request("/api/agents?projectId=p9"));
    expect(mockedListForUser).toHaveBeenCalledWith("u1", "p9");
  });
});

describe("POST /api/agents — création avec rattachement org", () => {
  const payload = { name: "Agent Studio", description: "desc", type: "universal" };

  it("sans orgId : création personnelle, opts { orgId: undefined }", async () => {
    const response = await POST(request("/api/agents", { method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json" } }));
    expect(response.status).toBe(201);
    expect(mockedCreateRecord).toHaveBeenCalledTimes(1);
    const [ownerId, input, opts] = mockedCreateRecord.mock.calls[0];
    expect(ownerId).toBe("u1");
    expect(input.name).toBe("Agent Studio");
    expect(opts).toEqual({ orgId: undefined });
  });

  it("avec orgId : l'orgId est transmis au dépôt (validation centralisée en aval)", async () => {
    const response = await POST(request("/api/agents", { method: "POST", body: JSON.stringify({ ...payload, orgId: "org-1" }), headers: { "content-type": "application/json" } }));
    expect(response.status).toBe(201);
    const [ownerId, , opts] = mockedCreateRecord.mock.calls[0];
    expect(ownerId).toBe("u1");
    expect(opts).toEqual({ orgId: "org-1" });
    // L'orgId n'est PAS dupliqué dans l'input (source unique : les options).
    const input = mockedCreateRecord.mock.calls[0][1] as Record<string, unknown>;
    expect(input.orgId).toBeUndefined();
  });

  it("échec d'attachement : l'erreur de la politique traverse (réponse explicite)", async () => {
    mockedCreateRecord.mockRejectedValue(new ResourceAccessError("Organisation introuvable ou accès refusé.", 403));
    const response = await POST(request("/api/agents", { method: "POST", body: JSON.stringify({ ...payload, orgId: "org-x" }), headers: { "content-type": "application/json" } }));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("Organisation");
  });
});

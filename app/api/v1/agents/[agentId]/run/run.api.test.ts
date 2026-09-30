import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Étape 7 du plan 20 — « Agent gen appelable par API ».
 * POST /api/v1/agents/{agentId}/run authentifié par clé API développeur
 * (g3x_…). Contrats verrouillés :
 *  1. sans clé valide → 401 structuré (jamais 500 opaque) ;
 *  2. l'agent doit appartenir au propriétaire de la clé → 404 sinon ;
 *  3. un agent non actif est refusé → 409 ;
 *  4. un objectif invalide est refusé → 400 ;
 *  5. le rate limit dédié s'applique → 429 ;
 *  6. l'exécution utilise le pipeline RÉEL (plan + politique dérivés de
 *     l'agent) et renvoie outputs/observations/billing ;
 *  7. un solde insuffisant renvoie 402 explicite.
 */

vi.mock("@/lib/extensions/developer-keys", () => ({ authenticateDeveloper: vi.fn() }));
vi.mock("@/lib/security/rate-limit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("@/lib/agents/repository", () => ({ getAgentForOwner: vi.fn() }));
vi.mock("@/lib/agents/personalized-plan", () => ({
  createPersonalizedPlan: vi.fn(),
  policyForAgent: vi.fn(),
}));
vi.mock("@/lib/agents/runtime/runner", () => ({ AgentRuntime: vi.fn() }));
vi.mock("@/lib/observability/logger", () => {
  const noop = () => undefined;
  const mk = () => ({ info: noop, warn: noop, error: noop, child: mk });
  return {
    executionLogger: () => mk(),
    safeError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
  };
});

import { authenticateDeveloper } from "@/lib/extensions/developer-keys";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getAgentForOwner } from "@/lib/agents/repository";
import { createPersonalizedPlan, policyForAgent } from "@/lib/agents/personalized-plan";
import { AgentRuntime } from "@/lib/agents/runtime/runner";
import { POST } from "./route";

const mockAuth = vi.mocked(authenticateDeveloper);
const mockLimit = vi.mocked(enforceRateLimit);
const mockGetAgent = vi.mocked(getAgentForOwner);
const mockPlan = vi.mocked(createPersonalizedPlan);
const mockPolicy = vi.mocked(policyForAgent);
const mockRuntime = vi.mocked(AgentRuntime);

const AGENT = {
  id: "agent_1",
  ownerId: "user_1",
  name: "Veilleur",
  description: "",
  type: "research" as const,
  typeLabel: "Veille",
  systemPrompt: "Tu es un agent de veille.",
  modelStrategy: "automatic" as const,
  temperature: 0.7,
  skills: [],
  agentMode: "standard" as const,
  autonomous: true,
  maxIterations: 8,
  tools: ["web.search"],
  memoryEnabled: true,
  webResearchEnabled: true,
  documentGenerationEnabled: true,
  voiceEnabled: false,
  mcpEnabled: true,
  authorizationMode: "always_ask" as const,
  status: "active" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function makeRequest(agentId = "agent_1", body: unknown = { objective: "Surveille le marché des drones" }) {
  return new NextRequest(`http://localhost/api/v1/agents/${agentId}/run`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      authorization: "Bearer g3x_test-key",
      "x-gen3ia-project-id": "proj_1",
    },
  });
}

const CONTEXT = (agentId = "agent_1") => ({ params: Promise.resolve({ agentId }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ userId: "user_1", via: "api_key", displayName: "Gen3ia developer", projectId: "proj_1" });
  mockLimit.mockResolvedValue({ allowed: true, remaining: 29, resetMs: 300_000 } as Awaited<ReturnType<typeof enforceRateLimit>>);
  mockGetAgent.mockResolvedValue(AGENT);
  mockPlan.mockReturnValue({
    executionId: "exec_1",
    objective: "x",
    steps: [{ id: "s1", type: "llm", name: "s", description: "s", dependencies: [], status: "pending", input: {}, skillIds: [], maxRetries: 2, timeoutMs: 120000, sideEffect: false, requiresApproval: false }],
    maxConcurrency: 1,
    maxIterations: 8,
  });
  mockPolicy.mockReturnValue({ allowedTools: ["web.search"] } as ReturnType<typeof policyForAgent>);
  mockRuntime.mockImplementation(function (this: unknown, options: { agent?: { agentId?: string }; userId?: string }) {
    return {
      run: async () => ({
        status: "completed",
        outputs: { s1: "Rapport de veille réel" },
        observations: [],
        billing: { totalMinor: 12 },
        options,
      }),
    } as unknown as InstanceType<typeof AgentRuntime>;
  } as unknown as typeof AgentRuntime);
});

describe("POST /api/v1/agents/[agentId]/run", () => {
  it("renvoie 401 structuré sans clé API valide", async () => {
    mockAuth.mockRejectedValue(new Error("Clé API Gen3ia invalide ou révoquée."));
    const response = await POST(makeRequest(), CONTEXT());
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toMatch(/Clé API/);
    expect(body.requestId).toBeTruthy();
  });

  it("renvoie 404 quand l'agent n'appartient pas au propriétaire de la clé", async () => {
    mockGetAgent.mockResolvedValue(null);
    const response = await POST(makeRequest(), CONTEXT());
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toMatch(/introuvable ou inaccessible/);
  });

  it("renvoie 409 quand l'agent n'est pas actif", async () => {
    mockGetAgent.mockResolvedValue({ ...AGENT, status: "paused" } as typeof AGENT);
    const response = await POST(makeRequest(), CONTEXT());
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/paused/);
  });

  it("renvoie 400 sur un objectif invalide", async () => {
    const response = await POST(makeRequest("agent_1", { objective: "ok" }), CONTEXT());
    expect(response.status).toBe(400);
  });

  it("renvoie 429 quand le rate limit dédié est épuisé", async () => {
    mockLimit.mockResolvedValue({ allowed: false, remaining: 0, resetMs: 60_000 } as Awaited<ReturnType<typeof enforceRateLimit>>);
    const response = await POST(makeRequest(), CONTEXT());
    expect(response.status).toBe(429);
  });

  it("exécute la mission via le pipeline réel et renvoie outputs + billing", async () => {
    const response = await POST(makeRequest(), CONTEXT());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("completed");
    expect(body.outputs).toEqual({ s1: "Rapport de veille réel" });
    expect(body.billing).toEqual({ totalMinor: 12 });
    expect(body.agent).toEqual({ id: "agent_1", name: "Veilleur", type: "research" });
    expect(mockPlan).toHaveBeenCalledWith(AGENT, "Surveille le marché des drones", expect.any(String));
    expect(mockPolicy).toHaveBeenCalledWith(AGENT);
    expect(mockRuntime).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1",
      agent: expect.objectContaining({ agentId: "agent_1", name: "Veilleur" }),
    }));
  });

  it("renvoie 402 explicite sur solde insuffisant", async () => {
    mockRuntime.mockImplementation(function () {
      return { run: async () => { throw new Error("Wallet balance too low"); } } as unknown as InstanceType<typeof AgentRuntime>;
    } as unknown as typeof AgentRuntime);
    const response = await POST(makeRequest(), CONTEXT());
    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.error).toMatch(/portefeuille/);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Étape 7 du plan 20 — hygiène des outils sur PATCH /api/agents/[id].
 * Contrats verrouillés :
 *  1. les outils du patch sont résolus vers le registre réel AVANT fusion
 *     (alias traduits, fantômes retirés) et auto_allow est durci si une
 *     action sensible est présente ;
 *  2. un patch sans tools/authorizationMode ne touche PAS aux outils et ne
 *     remonte aucun toolReport.
 */

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/agents/repository", () => ({
  deleteAgentForUser: vi.fn(),
  getAgentForUser: vi.fn(),
  toSummary: vi.fn((record: Record<string, unknown>) => ({ id: record.id, name: record.name, tools: record.tools })),
  updateAgentForUser: vi.fn(),
}));
vi.mock("@/lib/developer/projects", () => ({ getDeveloperProject: vi.fn() }));

import { requireUser } from "@/lib/security/authenticated-request";
import { getAgentForUser, updateAgentForUser } from "@/lib/agents/repository";

const mockUser = vi.mocked(requireUser);
const mockGetAgent = vi.mocked(getAgentForUser);
const mockUpdate = vi.mocked(updateAgentForUser);

const CURRENT_AGENT = {
  id: "agent_1", ownerId: "user_1", name: "A", description: "", type: "universal" as const,
  systemPrompt: "p", modelStrategy: "automatic" as const, autonomous: true, maxIterations: 8,
  tools: ["web.search"], memoryEnabled: true, webResearchEnabled: true, documentGenerationEnabled: true,
  voiceEnabled: false, mcpEnabled: true, authorizationMode: "always_ask" as const, status: "active" as const,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUser.mockResolvedValue({ uid: "user_1" } as Awaited<ReturnType<typeof requireUser>>);
  mockGetAgent.mockResolvedValue(CURRENT_AGENT as Awaited<ReturnType<typeof getAgentForUser>>);
  mockUpdate.mockImplementation(async (_uid, _id, patch) => ({
    ...CURRENT_AGENT,
    tools: patch.tools ?? CURRENT_AGENT.tools,
    authorizationMode: patch.authorizationMode ?? CURRENT_AGENT.authorizationMode,
    name: patch.name ?? CURRENT_AGENT.name,
  } as never));
});

function patchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/agents/agent_1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const CONTEXT = { params: Promise.resolve({ id: "agent_1" }) };

describe("PATCH /api/agents/[id] — mise à jour hygiénique", () => {
  it("résout les outils du patch avant fusion et signale les changements", async () => {
    const { PATCH } = await import("./route");
    const response = await PATCH(
      patchRequest({ tools: ["Gmail", "slack"], authorizationMode: "auto_allow" }),
      CONTEXT,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const patch = mockUpdate.mock.calls[0]?.[2] as { tools: string[]; authorizationMode: string };
    expect(patch.tools).toContain("email.send");
    expect(patch.tools).toContain("messaging.send");
    expect(patch.tools).not.toContain("Gmail");
    expect(patch.authorizationMode).toBe("ask_if_needed");
    expect(body.toolReport.hardened).toBe(true);
  });

  it("ne touche pas aux outils quand le patch ne les mentionne pas", async () => {
    const { PATCH } = await import("./route");
    const response = await PATCH(patchRequest({ name: "Nouveau nom" }), CONTEXT);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(mockUpdate.mock.calls[0]?.[2]).not.toHaveProperty("tools");
    expect(body.toolReport).toBeUndefined();
  });

  it("renvoie 404 quand l'agent est introuvable", async () => {
    const { PATCH } = await import("./route");
    mockGetAgent.mockResolvedValue(null);
    const response = await PATCH(patchRequest({ tools: ["Gmail"] }), CONTEXT);
    expect(response.status).toBe(404);
  });
});

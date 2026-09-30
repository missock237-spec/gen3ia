import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Étape 7 du plan 20 — hygiène des outils « en clair » sur /api/agents/generate
 * et POST /api/agents. Contrats verrouillés :
 *  1. la proposal retournée ne contient que des outils réels (alias mappés,
 *     fantômes retirés) + toolReport + auto_allow durci ;
 *  2. les outils sont résolus AVANT createAgentRecord (aucun fantôme
 *     persisté) et le toolReport accompagne le 201 si changement ;
 *  3. aucune remontée de toolReport quand la config est déjà propre.
 */

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (fn: () => unknown) => { try { fn(); } catch { /* best-effort */ } } };
});

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/security/rate-limit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("@/lib/ai/router", () => ({ generate: vi.fn() }));
vi.mock("@/lib/agents/repository", () => ({
  createAgentRecord: vi.fn(),
  getAgentForOwner: vi.fn(),
  listAgentsByOwner: vi.fn(),
  toSummary: vi.fn((record: Record<string, unknown>) => ({ id: record.id, name: record.name, tools: record.tools })),
  updateAgentForOwner: vi.fn(),
}));
vi.mock("@/lib/developer/projects", () => ({ getDeveloperProject: vi.fn() }));

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { generate } from "@/lib/ai/router";
import { createAgentRecord } from "@/lib/agents/repository";
import { getDeveloperProject } from "@/lib/developer/projects";

const mockUser = vi.mocked(requireUser);
const mockLimit = vi.mocked(enforceRateLimit);
const mockGenerate = vi.mocked(generate);
const mockCreate = vi.mocked(createAgentRecord);

beforeEach(() => {
  vi.clearAllMocks();
  mockUser.mockResolvedValue({ uid: "user_1" } as Awaited<ReturnType<typeof requireUser>>);
  mockLimit.mockResolvedValue({ allowed: true, remaining: 19, resetMs: 3_600_000 } as Awaited<ReturnType<typeof enforceRateLimit>>);
  mockCreate.mockImplementation(async (_uid, input) => ({
    id: "agent_new", ownerId: "user_1", name: input.name, description: input.description,
    type: input.type, systemPrompt: input.systemPrompt, modelStrategy: "automatic" as const,
    autonomous: true, maxIterations: 8, tools: input.tools, memoryEnabled: true,
    webResearchEnabled: true, documentGenerationEnabled: true, voiceEnabled: false, mcpEnabled: true,
    authorizationMode: input.authorizationMode, status: "active" as const,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  } as never));
});

function post(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/agents/generate — proposal assainie", () => {
  it("retourne une proposal sans outil fantôme + toolReport (alias mappé, inconnu retiré)", async () => {
    const { POST } = await import("./generate/route");
    mockGenerate.mockResolvedValue({
      text: JSON.stringify({
        name: "Assistant Gmail",
        description: "Agent qui analyse les emails et fait une veille.",
        type: "automation",
        skills: ["email"],
        systemPrompt: "Tu analyses les emails de l'utilisateur et tu fais de la veille quotidienne.",
        tools: ["Gmail", "recherche web", "Jira"],
        webResearchEnabled: true,
        codeExecutionEnabled: false,
        documentGenerationEnabled: true,
        authorizationMode: "auto_allow",
        reasoning: "Choix dictés par le besoin.",
      }),
    } as never);
    const response = await POST(post("/api/agents/generate", { description: "Un agent qui analyse mes emails et surveille l'actualité" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.proposal.tools).not.toContain("Gmail");
    expect(body.proposal.tools).not.toContain("Jira");
    expect(body.proposal.tools).toContain("email.send");
    expect(body.proposal.tools).toContain("web.search");
    // Durcissement : auto_allow + email.send (external) → ask_if_needed.
    expect(body.proposal.authorizationMode).toBe("ask_if_needed");
    expect(body.toolReport.mapped).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "Gmail", to: "email.send" }),
    ]));
    expect(body.toolReport.removed).toEqual([expect.objectContaining({ from: "Jira" })]);
    expect(body.toolReport.hardened).toBe(true);
  });
});

describe("POST /api/agents — création hygiénique", () => {
  it("persiste uniquement les outils réels et renvoie le toolReport", async () => {
    const { POST } = await import("./route");
    vi.mocked(getDeveloperProject).mockResolvedValue({ id: "proj_1" } as never);
    const response = await POST(post("/api/agents", {
      name: "Veilleur Email",
      description: "Surveille ma boîte mail et fait de la veille.",
      type: "automation",
      systemPrompt: "Tu surveilles les emails et l'actualité de ton secteur.",
      tools: ["Gmail", "web.search", "outil inexistant"],
      authorizationMode: "auto_allow",
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    const persisted = mockCreate.mock.calls[0]?.[1] as { tools: string[]; authorizationMode: string };
    expect(persisted.tools).toContain("email.send");
    expect(persisted.tools).toContain("web.search");
    expect(persisted.tools).not.toContain("Gmail");
    expect(persisted.tools).not.toContain("outil inexistant");
    expect(persisted.authorizationMode).toBe("ask_if_needed");
    expect(body.toolReport.removed).toEqual([expect.objectContaining({ from: "outil inexistant" })]);
    expect(body.agent.tools).toEqual(persisted.tools);
  });

  it("ne renvoie PAS de toolReport quand la config est déjà propre", async () => {
    const { POST } = await import("./route");
    vi.mocked(getDeveloperProject).mockResolvedValue({ id: "proj_1" } as never);
    const response = await POST(post("/api/agents", {
      name: "Chercheur",
      description: "Recherche web simple et rédigée.",
      type: "research",
      systemPrompt: "Tu fais de la recherche web.",
      tools: ["web.search"],
      authorizationMode: "always_ask",
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.toolReport).toBeUndefined();
    expect(body.agent.tools).toEqual(["web.search"]);
  });
});

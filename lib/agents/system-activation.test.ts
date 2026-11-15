import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Activation interne du système agent (demande utilisateur n°5) :
 *  - les sous-agents créés sont des AgentRecordInput VALIDES (schéma réel)
 *    avec des outils RÉELS du registre exécutable (aucun outil fantôme) ;
 *  - l'activation est idempotente (marqueur de compétence + plafond) ;
 *  - l'activation partielle crée uniquement les manquants ;
 *  - un userId vide est refusé honnêtement.
 */

const mockedListForUser = vi.fn();
const mockedCreateRecord = vi.fn();

vi.mock("./repository", () => ({
  listAgentsForUser: (...args: unknown[]) => mockedListForUser(...args),
  createAgentRecord: (...args: unknown[]) => mockedCreateRecord(...args),
}));

vi.mock("@/lib/security/audit-events", () => ({
  recordAuditEventSafe: vi.fn(),
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  activateAgentSystemForUser,
  buildBrowserAssistSubAgents,
  BROWSER_ASSIST_TOOLS,
  MAX_BROWSER_ASSIST_SUBAGENTS,
  SYSTEM_AGENT_SKILL_MARKER,
} from "./system-activation";
import { AgentRecordSchema } from "./schema";
import { GEN3IA_TOOLS } from "@/lib/tools/registry";
import type { AgentRecord } from "./schema";

function fakeRecord(name: string, skills: string[] = []): AgentRecord {
  return AgentRecordSchema.parse({
    name,
    description: "Sous-agent système navigateur.",
    type: "research",
    tools: [...BROWSER_ASSIST_TOOLS],
    skills,
    status: "active",
  }) as unknown as AgentRecord;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedListForUser.mockResolvedValue([]);
  mockedCreateRecord.mockImplementation(async (_uid: string, input: { name: string }) => ({
    ...fakeRecord(input.name),
    id: `agent_${mockedCreateRecord.mock.calls.length}`,
    ownerId: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
});

describe("buildBrowserAssistSubAgents — sous-agents navigateur", () => {
  it("produit des définitions valides selon le schéma AgentRecord réel", () => {
    const definitions = buildBrowserAssistSubAgents("aide-moi à surveiller ce site");
    expect(definitions.length).toBeGreaterThanOrEqual(2);
    for (const definition of definitions) {
      const parsed = AgentRecordSchema.safeParse(definition);
      expect(parsed.success).toBe(true);
      expect(definition.skills).toContain(SYSTEM_AGENT_SKILL_MARKER);
      expect(definition.status).toBe("active");
      expect(definition.systemPrompt?.length ?? 0).toBeGreaterThanOrEqual(10);
    }
  });

  it("ne déclare que des outils RÉELS du registre exécutable (aucun fantôme)", () => {
    const registryNames = new Set(GEN3IA_TOOLS.map((tool) => tool.name));
    expect(BROWSER_ASSIST_TOOLS.length).toBeGreaterThan(0);
    for (const tool of BROWSER_ASSIST_TOOLS) {
      expect(registryNames.has(tool)).toBe(true);
    }
    for (const definition of buildBrowserAssistSubAgents()) {
      for (const tool of definition.tools ?? []) {
        expect(registryNames.has(tool)).toBe(true);
      }
    }
  });

  it("branche le motif énoncé (demande du chat) dans la description, borné", () => {
    const [premier] = buildBrowserAssistSubAgents("surveiller les prix concurrents");
    expect(premier?.description).toContain("surveiller les prix concurrents");
  });
});

describe("activateAgentSystemForUser — mécanique réelle", () => {
  it("crée les sous-agents manquants via createAgentRecord (persistance réelle)", async () => {
    const result = await activateAgentSystemForUser({ userId: "user-1", demande: "recherche concurrents", source: "chat" });
    expect(result.activated).toBe(true);
    expect(mockedCreateRecord).toHaveBeenCalledTimes(MAX_BROWSER_ASSIST_SUBAGENTS);
    expect(result.subAgents).toHaveLength(MAX_BROWSER_ASSIST_SUBAGENTS);
    expect(mockedCreateRecord.mock.calls[0]?.[0]).toBe("user-1");
  });

  it("est idempotent : sous-agents déjà actifs → aucun doublon créé", async () => {
    mockedListForUser.mockResolvedValue([
      fakeRecord("Assistant Navigateur — Recherche Web", [SYSTEM_AGENT_SKILL_MARKER]),
      fakeRecord("Assistant Navigateur — Veille Missions", [SYSTEM_AGENT_SKILL_MARKER]),
    ]);
    const result = await activateAgentSystemForUser({ userId: "user-1" });
    expect(result.activated).toBe(false);
    expect(result.reason).toBe("already_active");
    expect(mockedCreateRecord).not.toHaveBeenCalled();
    expect(result.subAgents).toHaveLength(MAX_BROWSER_ASSIST_SUBAGENTS);
  });

  it("activation partielle : crée UNIQUEMENT les manquants", async () => {
    mockedListForUser.mockResolvedValue([
      fakeRecord("Assistant Navigateur — Recherche Web", [SYSTEM_AGENT_SKILL_MARKER]),
    ]);
    const result = await activateAgentSystemForUser({ userId: "user-1" });
    expect(result.activated).toBe(true);
    expect(mockedCreateRecord).toHaveBeenCalledTimes(1);
    expect(mockedCreateRecord.mock.calls[0]?.[1]).toMatchObject({ name: "Assistant Navigateur — Veille Missions" });
  });

  it("ignore les agents sans marqueur : un agent utilisateur ne bloque pas l'activation", async () => {
    mockedListForUser.mockResolvedValue([
      fakeRecord("Assistant Navigateur — Recherche Web", []), // même nom, PAS système
    ]);
    const result = await activateAgentSystemForUser({ userId: "user-1" });
    expect(result.activated).toBe(true);
    expect(mockedCreateRecord).toHaveBeenCalledTimes(2);
  });

  it("refuse un userId vide (invalid_user, aucune écriture)", async () => {
    const result = await activateAgentSystemForUser({ userId: "   " });
    expect(result).toMatchObject({ activated: false, reason: "invalid_user", subAgents: [] });
    expect(mockedCreateRecord).not.toHaveBeenCalled();
  });
});

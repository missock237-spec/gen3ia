import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Synchronisation agent Gen3ia ⇄ agent Bland AI :
 *  - construction du snapshot v2 (graphe start→scénario, settings, contact) ;
 *  - adaptation du prompt système à la conversation orale (interdictions
 *    Markdown, règles téléphoniques, contraintes persona) ;
 *  - mappage des langues Gen3ia → codes Bland ;
 *  - staleness : resynchronisation dès que l'agent Gen3ia change après la
 *    dernière synchro (c'est LE contrat de synchronisation continue) ;
 *  - cycle complet : création → publish → promote → persistance du mapping.
 */

const blandState = vi.hoisted(() => ({
  createdAgents: [] as string[],
  published: [] as { agentId: string; semver: string }[],
  promoted: [] as string[],
}));

vi.mock("@/lib/integrations/bland/client", () => ({
  createBlandAgent: vi.fn(async (name: string) => {
    blandState.createdAgents.push(name);
    const agent = { id: `bland-${blandState.createdAgents.length}`, org_id: "org", name, created_at: "", updated_at: "", deleted_at: null };
    return { agent, environments: [] };
  }),
  publishBlandAgentSnapshot: vi.fn(async (agentId: string) => {
    const semver = `0.${blandState.published.length + 1}.0`;
    blandState.published.push({ agentId, semver });
    return { versionId: `ver-${semver}`, semver, environments: [] };
  }),
  promoteBlandAgent: vi.fn(async (agentId: string) => {
    blandState.promoted.push(agentId);
    return { semver: "0.1.0", environments: [] };
  }),
}));

const repoState = vi.hoisted(() => ({
  agents: new Map<string, Record<string, unknown>>(),
  updates: [] as Array<{ agentId: string; patch: Record<string, unknown> }>,
}));

vi.mock("@/lib/agents/repository", () => ({
  updateAgentForUser: vi.fn(async (userId: string, agentId: string, patch: Record<string, unknown>) => {
    repoState.updates.push({ agentId, patch });
    const agent = repoState.agents.get(agentId);
    if (!agent) return null;
    const next = { ...agent, ...patch, voiceConfig: { ...(agent.voiceConfig as Record<string, unknown>), ...(patch.voiceConfig as Record<string, unknown>) } };
    repoState.agents.set(agentId, next);
    return next;
  }),
}));

import {
  buildBlandScenarioRule,
  buildBlandSnapshot,
  buildBlandSystemPrompt,
  ensureAgentSynced,
  isBlandSyncStale,
  mapGen3iaLanguageToBland,
  syncAgentToBland,
} from "@/lib/voice/bland-agent-sync";
import type { AgentRecord } from "@/lib/agents/schema";

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  const base: AgentRecord = {
    id: "agent-1",
    ownerId: "user-1",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    name: "Assistant Dental",
    description: "Gérer les rendez-vous de la clinique.",
    type: "vocal",
    agentMode: "call",
    status: "active",
    skills: ["prise de rendez-vous", "relances"],
    systemPrompt: "Tu gères l'accueil de la clinique Northwind Dental.",
    memoryEnabled: true,
    voiceEnabled: true,
    voiceConfig: {
      language: "fr-FR",
      greeting: "Bonjour, clinique Northwind !",
      maxTurns: 20,
      maxDurationSeconds: 300,
      inboundEnabled: true,
      outboundEnabled: true,
      voiceEnabled: true,
    },
    temperature: 0.7,
    tools: [],
  } as unknown as AgentRecord;
  const { voiceConfig, ...rest } = overrides;
  return {
    ...base,
    ...rest,
    ...(voiceConfig ? { voiceConfig: { ...base.voiceConfig, ...voiceConfig } } : {}),
  };
}

beforeEach(() => {
  blandState.createdAgents = [];
  blandState.published = [];
  blandState.promoted = [];
  repoState.agents.clear();
  repoState.updates = [];
});

describe("Projection du prompt et du snapshot", () => {
  it("le prompt système adapte l'agent à l'oral et interdit le Markdown", () => {
    const prompt = buildBlandSystemPrompt(makeAgent());
    expect(prompt).toContain("Assistant Dental");
    expect(prompt).toContain("Northwind Dental");
    expect(prompt).toContain("TÉLÉPHONIQUE");
    expect(prompt).toContain("Interdictions : Markdown");
  });

  it("les contraintes persona sont projetées comme règles absolues", () => {
    const agent = makeAgent({
      persona: {
        tone: "direct",
        verbosity: "concis",
        humor: "aucun",
        language: "Français",
        constraints: ["Jamais de diagnostics médicaux"],
        capabilities: { webSearch: true, codeExecution: true, dataAnalysis: true, fileGeneration: true },
      } as unknown as AgentRecord["persona"],
    });
    const prompt = buildBlandSystemPrompt(agent);
    expect(prompt).toContain("Jamais de diagnostics médicaux");
    expect(prompt).toContain("Règles absolues");
  });

  it("le snapshot v2 est complet : behavior start→scénario, settings, contact", () => {
    const snapshot = buildBlandSnapshot(makeAgent());
    expect(snapshot.behavior.nodes).toHaveLength(2);
    expect(snapshot.behavior.nodes[0].type).toBe("start");
    expect(snapshot.behavior.nodes[1].type).toBe("scenario");
    expect(snapshot.behavior.edges).toHaveLength(1);
    expect(snapshot.behavior.edges[0].source).toBe(snapshot.behavior.nodes[0].id);
    expect(snapshot.behavior.edges[0].target).toBe(snapshot.behavior.nodes[1].id);
    expect(snapshot.settings.displayName).toBe("Assistant Dental");
    expect(snapshot.settings.languages).toEqual(["fr"]);
    expect(snapshot.settings.voice).toBe("nat");
    expect(snapshot.settings.voiceCall).toBe(true);
    expect(snapshot.settings.webChat).toBe(false);
    expect(snapshot.contact.inboundNumbers).toEqual([]);
    expect(String((snapshot.behavior.nodes[1].data as { rule: string }).rule)).toContain("rendez-vous");
  });

  it("la langue Gen3ia est mappée vers le code Bland", () => {
    expect(mapGen3iaLanguageToBland("fr-FR")).toBe("fr");
    expect(mapGen3iaLanguageToBland("en-US")).toBe("en");
    expect(mapGen3iaLanguageToBland("es-ES")).toBe("es");
    expect(mapGen3iaLanguageToBland("de-DE")).toBe("de");
    expect(mapGen3iaLanguageToBland(undefined)).toBe("fr");
  });

  it("la règle du scénario embarque description + compétences", () => {
    const rule = buildBlandScenarioRule(makeAgent());
    expect(rule).toContain("Gérer les rendez-vous");
    expect(rule).toContain("prise de rendez-vous");
  });
});

describe("Staleness — détection de désynchronisation", () => {
  it("agent sans mapping Bland → obsolète", () => {
    expect(isBlandSyncStale(makeAgent())).toBe(true);
  });

  it("mapping frais (sync après dernière modification) → à jour", () => {
    const agent = makeAgent({
      updatedAt: "2026-10-10T10:00:00.000Z",
      voiceConfig: {
        language: "fr-FR",
        greeting: "Bonjour !",
        maxTurns: 20,
        maxDurationSeconds: 300,
        inboundEnabled: true,
        outboundEnabled: true,
        voiceEnabled: true,
        blandAgentId: "bland-existing",
        blandSyncedAt: "2026-10-10T10:00:05.000Z",
      } as AgentRecord["voiceConfig"],
    });
    expect(isBlandSyncStale(agent)).toBe(false);
  });

  it("agent Gen3ia modifié après la synchro → obsolète (resynchronisation requise)", () => {
    const agent = makeAgent({
      updatedAt: "2026-10-10T10:00:00.000Z",
      voiceConfig: {
        language: "fr-FR",
        greeting: "Bonjour !",
        maxTurns: 20,
        maxDurationSeconds: 300,
        inboundEnabled: true,
        outboundEnabled: true,
        voiceEnabled: true,
        blandAgentId: "bland-existing",
        blandSyncedAt: "2026-10-09T10:00:00.000Z",
      } as AgentRecord["voiceConfig"],
    });
    expect(isBlandSyncStale(agent)).toBe(true);
  });
});

describe("Cycle de synchronisation", () => {
  it("syncAgentToBland : crée l'agent Bland, publie, promeut et persiste le mapping", async () => {
    const agent = makeAgent();
    repoState.agents.set(agent.id, { ...agent } as unknown as Record<string, unknown>);

    const result = await syncAgentToBland("user-1", agent);

    expect(blandState.createdAgents).toEqual(["Gen3ia · Assistant Dental"]);
    expect(result.blandAgentId).toBe("bland-1");
    expect(blandState.published).toHaveLength(1);
    expect(blandState.published[0].agentId).toBe("bland-1");
    expect(blandState.promoted).toEqual(["bland-1"]);
    // Persistance du mapping dans voiceConfig.
    expect(repoState.updates).toHaveLength(1);
    const patch = repoState.updates[0].patch.voiceConfig as Record<string, unknown>;
    expect(patch.blandAgentId).toBe("bland-1");
    expect(patch.blandSyncedAt).toBe(result.syncedAt);
  });

  it("refuse un agent sans voix activée", async () => {
    await expect(syncAgentToBland("user-1", makeAgent({ voiceEnabled: false }))).rejects.toThrow(/voix/i);
  });

  it("ensureAgentSynced : pas de double synchro si le mapping est frais", async () => {
    const agent = makeAgent({
      updatedAt: "2026-10-10T10:00:00.000Z",
      voiceConfig: {
        language: "fr-FR",
        greeting: "Bonjour !",
        maxTurns: 20,
        maxDurationSeconds: 300,
        inboundEnabled: true,
        outboundEnabled: true,
        voiceEnabled: true,
        blandAgentId: "bland-existing",
        blandSyncedAt: "2026-10-10T10:00:05.000Z",
        blandSemver: "1.2.0",
      } as AgentRecord["voiceConfig"],
    });
    const result = await ensureAgentSynced("user-1", agent);
    expect(result.blandAgentId).toBe("bland-existing");
    expect(result.created).toBe(false);
    expect(blandState.createdAgents).toHaveLength(0);
  });

  it("ensureAgentSynced : resynchronise automatiquement un agent obsolète", async () => {
    const agent = makeAgent(); // sans mapping → obsolète
    repoState.agents.set(agent.id, { ...agent } as unknown as Record<string, unknown>);
    const result = await ensureAgentSynced("user-1", agent);
    expect(result.created).toBe(true);
    expect(blandState.published).toHaveLength(1);
  });
});

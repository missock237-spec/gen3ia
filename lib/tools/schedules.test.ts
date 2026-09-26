import { beforeEach, describe, expect, it, vi } from "vitest";

const { listAgentsByOwner, createAgentRecord, createScheduleMock } = vi.hoisted(() => ({
  listAgentsByOwner: vi.fn(),
  createAgentRecord: vi.fn(),
  createScheduleMock: vi.fn(),
}));

vi.mock("@/lib/agents/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/repository")>();
  return {
    ...actual,
    listAgentsByOwner: (...args: unknown[]) => listAgentsByOwner(...args),
    createAgentRecord: (...args: unknown[]) => createAgentRecord(...args),
  };
});

vi.mock("@/lib/agents/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/scheduler")>();
  return {
    ...actual,
    createSchedule: (...args: unknown[]) => createScheduleMock(...args),
    listSchedules: vi.fn(async () => []),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
  };
});

import {
  resolveScheduleAgent,
  scheduleCreateTool,
  scheduleDeleteTool,
  scheduleListTool,
  scheduleUpdateTool,
  describeRecurrence,
} from "@/lib/tools/schedules";
import type { AgentRecord } from "@/lib/agents/schema";

function fabriquerAgent(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    id: "agent-1",
    ownerId: "u1",
    name: "Agent",
    description: "",
    type: "universal",
    skills: [],
    agentMode: "standard",
    status: "active",
    voiceEnabled: false,
    modelStrategy: "auto",
    persona: { tone: "professionnel", verbosity: "equilibre", humor: "aucun", language: "Français", constraints: [], capabilities: { webSearch: true, codeExecution: true, dataAnalysis: true, fileGeneration: true } },
    memoryEnabled: true,
    systemPrompt: "Prompt",
    tools: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as AgentRecord;
}

const context = { userId: "u1", executionId: "exec-1" };

describe("résolution de l'agent de planification", () => {
  beforeEach(() => {
    listAgentsByOwner.mockReset();
    createAgentRecord.mockReset();
  });

  it("préfère un agent d'automatisation actif", async () => {
    listAgentsByOwner.mockResolvedValue([
      fabriquerAgent({ id: "a-universel", type: "universal" }),
      fabriquerAgent({ id: "a-automation", type: "automation" }),
    ]);
    const { agent } = await resolveScheduleAgent("u1", undefined, "objectif");
    expect(agent.id).toBe("a-automation");
    expect(createAgentRecord).not.toHaveBeenCalled();
  });

  it("crée un agent d'automatisation dédié si aucun actif", async () => {
    listAgentsByOwner.mockResolvedValue([]);
    createAgentRecord.mockResolvedValue(fabriquerAgent({ id: "a-nouveau", type: "automation" }));
    const { agent, created } = await resolveScheduleAgent("u1", undefined, "objectif");
    expect(created).toBe(true);
    expect(agent.id).toBe("a-nouveau");
    expect(createAgentRecord).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ type: "automation", status: "active" }),
    );
  });

  it("refuse un agentId qui n'appartient pas au compte", async () => {
    listAgentsByOwner.mockResolvedValue([fabriquerAgent({ id: "autre" })]);
    await expect(resolveScheduleAgent("u1", "inconnu", "objectif")).rejects.toThrow("introuvable");
  });
});

describe("outils schedule.*", () => {
  beforeEach(() => {
    listAgentsByOwner.mockReset();
    createAgentRecord.mockReset();
    createScheduleMock.mockReset();
  });

  it("schedule.create appelle le scheduler réel avec l'agent résolu", async () => {
    listAgentsByOwner.mockResolvedValue([fabriquerAgent({ id: "a-automation", type: "automation" })]);
    createScheduleMock.mockResolvedValue({
      id: "sched-1",
      name: "Rapport IA",
      objective: "rapport",
      timezone: "Africa/Douala",
      daysOfWeek: [1],
      startTime: "09:00",
      endTime: "23:59",
      intervalMinutes: 0,
      enabled: true,
    });
    const output = await scheduleCreateTool.execute(
      {
        objective: "rapport des actualités IA",
        name: "Rapport IA",
        daysOfWeek: [1],
        startTime: "09:00",
        endTime: "23:59",
        timezone: "Africa/Douala",
      },
      context,
    );
    expect(output.created).toBe(true);
    expect(output.schedule.id).toBe("sched-1");
    expect(output.agent.id).toBe("a-automation");
    expect(createScheduleMock).toHaveBeenCalledWith("u1", expect.objectContaining({ agentId: "a-automation", timezone: "Africa/Douala" }));
  });

  it("schedule.list échoue proprement quand aucune API Firestore n'est dispo", async () => {
    // Le stub renvoie une liste vide : l'outil répond count 0 sans lever.
    const output = await scheduleListTool.execute({}, context);
    expect(output.count).toBe(0);
    expect(output.schedules).toEqual([]);
  });

  it("schedule.update exige au moins un champ avant le ciblage", async () => {
    await expect(scheduleUpdateTool.execute({}, context)).rejects.toThrow("Aucune modification");
  });

  it("schedule.delete est classé high (validation humaine)", () => {
    expect(scheduleDeleteTool.risk).toBe("high");
  });

  it("décrit la récurrence en français lisible", () => {
    expect(describeRecurrence({ daysOfWeek: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "18:00", intervalMinutes: 0 })).toContain("lundi");
    expect(describeRecurrence({ intervalMinutes: 30, alwaysOnWebhookToken: "t" })).toBe("déclenchement par webhook (à chaque événement entrant)");
  });
});

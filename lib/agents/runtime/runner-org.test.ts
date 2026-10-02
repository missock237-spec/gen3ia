import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cloisonnement multi-tenant du runner (Task 58, priorité #1 — migration
 * orgId) : l'état d'exécution porte l'organisation propriétaire dès la
 * construction — source agent (prime), source explicite (file mission,
 * tâche workspace, API), ou aucune (exécution personnelle, champ absent —
 * comportement historique). Le checkpoint persiste l'état tel quel
 * (spread) : la présence de l'orgId dans le createCheckpoint INITIAL
 * prouve sa persistance sur TOUTES les écritures de la collection
 * `executions`.
 */

vi.mock("@/lib/billing/wallet", () => ({
  getWallet: vi.fn(async () => ({ availableMinor: 500_000, currency: "XAF" })),
  WALLET_CURRENCY: "XAF",
}));
vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: vi.fn(async () => ({
    chargeMinor: 2,
    providerCostEur: 0.001,
    response: { text: "Sortie d'étape réelle simulée.", usage: { inputTokens: 10, outputTokens: 5 } },
  })),
}));
vi.mock("./checkpoint", () => ({
  createCheckpoint: vi.fn(async () => undefined),
  saveCheckpoint: vi.fn(async () => undefined),
}));
vi.mock("./pause", async (importOriginal) => {
  const original = await importOriginal<typeof import("./pause")>();
  return {
    ...original,
    assertNotPaused: vi.fn(async () => undefined),
    assertNotStopped: vi.fn(async () => undefined),
  };
});
vi.mock("@/lib/agents/repository", () => ({ getAgentForOwner: vi.fn(async () => null) }));
vi.mock("@/lib/security/execution-policy", () => ({
  DEFAULT_EXECUTION_POLICY: { maxConcurrency: 4, maxTotalRetries: 15, budgetEurMinor: 500 },
  ExecutionPolicy: class {},
}));

import { AgentRuntime, type RuntimePlan } from "./runner";
import { createCheckpoint } from "./checkpoint";

const mockedCreateCheckpoint = vi.mocked(createCheckpoint);

function singleStepPlan(executionId = "exec-org"): RuntimePlan {
  return {
    executionId,
    objective: "Mission org-aware",
    steps: [{
      id: "s1",
      type: "llm",
      name: "Étape 1",
      description: "Travail LLM",
      dependencies: [],
      status: "pending",
      input: {},
      skillIds: [],
      maxRetries: 2,
      timeoutMs: 120_000,
      sideEffect: false,
      requiresApproval: false,
    }],
    maxConcurrency: 1,
    maxIterations: 10,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentRuntime — orgId d'exécution (Task 58)", () => {
  it("agent rattaché à une organisation : l'état porte l'orgId de l'agent", async () => {
    const runtime = new AgentRuntime({
      userId: "u1",
      objective: "Mission d'organisation",
      plan: singleStepPlan(),
      agent: { name: "Agent Org", orgId: "org-1" },
    });
    await runtime.run();
    expect(mockedCreateCheckpoint).toHaveBeenCalled();
    const state = mockedCreateCheckpoint.mock.calls[0][0];
    expect(state.orgId).toBe("org-1");
  });

  it("source explicite sans agent (file mission, tâche workspace) : l'orgId est repris", async () => {
    const runtime = new AgentRuntime({
      userId: "u1",
      objective: "Mission enfilée d'organisation",
      plan: singleStepPlan(),
      orgId: "org-2",
    });
    await runtime.run();
    const state = mockedCreateCheckpoint.mock.calls[0][0];
    expect(state.orgId).toBe("org-2");
  });

  it("l'orgId de l'agent PRIME sur la source explicite", async () => {
    const runtime = new AgentRuntime({
      userId: "u1",
      objective: "Priorité de la source agent",
      plan: singleStepPlan(),
      orgId: "org-explicite",
      agent: { name: "Agent Org", orgId: "org-agent" },
    });
    await runtime.run();
    const state = mockedCreateCheckpoint.mock.calls[0][0];
    expect(state.orgId).toBe("org-agent");
  });

  it("orgId vide ou blanc : traité comme absent (aucun champ écrit)", async () => {
    const runtime = new AgentRuntime({
      userId: "u1",
      objective: "orgId blanc",
      plan: singleStepPlan(),
      orgId: "   ",
    });
    await runtime.run();
    const state = mockedCreateCheckpoint.mock.calls[0][0];
    expect(state.orgId).toBeUndefined();
    expect("orgId" in state).toBe(false);
  });

  it("sans aucune source : exécution personnelle — orgId ABSENT (comportement historique)", async () => {
    const runtime = new AgentRuntime({
      userId: "u1",
      objective: "Mission personnelle",
      plan: singleStepPlan(),
    });
    await runtime.run();
    const state = mockedCreateCheckpoint.mock.calls[0][0];
    expect("orgId" in state).toBe(false);
  });
});

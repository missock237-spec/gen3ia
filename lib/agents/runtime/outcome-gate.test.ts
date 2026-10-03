import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PORTE DE RÉSULTAT du runner (concepts #1/#2) : une mission sous contrat
 * n'est « completed » que si ses critères d'acceptation sont vérifiés ;
 * sinon, au plus UNE passe de correction des étapes livrables (feedback du
 * verdict injecté), puis échec honnête. Panne du juge = porte levée
 * (`unavailable`), jamais de faux « critères atteints ». Sans contrat, le
 * runtime conserve son comportement historique (zéro appel de juge).
 */

const generateForUserMock = vi.fn();

vi.mock("@/lib/billing/wallet", () => ({
  getWallet: vi.fn(async () => ({ availableMinor: 500_000, currency: "XAF", balanceMinor: 500_000, reservedMinor: 0 })),
  WALLET_CURRENCY: "XAF",
}));
vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: (...args: unknown[]) => generateForUserMock(...args),
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
vi.mock("@/lib/agents/repository", () => ({ getAgentForUser: vi.fn(async () => null) }));
vi.mock("@/lib/security/execution-policy", () => ({
  DEFAULT_EXECUTION_POLICY: { maxConcurrency: 4, maxTotalRetries: 15, budgetEurMinor: 500 },
  ExecutionPolicy: class {},
}));

import { AgentRuntime, type RuntimePlan } from "./runner";
import { saveCheckpoint } from "./checkpoint";

const mockedSaveCheckpoint = vi.mocked(saveCheckpoint);

function deliverablePlan(executionId = "exec-gate"): RuntimePlan {
  return {
    executionId,
    objective: "Produire une note citant le chiffre de croissance",
    steps: [
      {
        id: "s1",
        type: "llm",
        name: "Rédaction",
        description: "Rédiger la note de synthèse",
        dependencies: [],
        status: "pending",
        input: {},
        skillIds: [],
        maxRetries: 2,
        timeoutMs: 120_000,
        sideEffect: false,
        requiresApproval: false,
      },
    ],
    maxConcurrency: 1,
    maxIterations: 10,
  };
}

const CONTRACT_CONTAINS = {
  criteria: [{ id: "c1", description: "cite 40 %", kind: "contains" as const, pattern: "40 %", required: true }],
  failPolicy: "retry_once" as const,
};

const CONTRACT_JUDGE = {
  criteria: [{ id: "quality", description: "analyse professionnelle", kind: "llm" as const, required: true }],
  failPolicy: "retry_once" as const,
};

function stepText(text: string) {
  return {
    chargeMinor: 2,
    providerCostEur: 0.001,
    response: { text, usage: { inputTokens: 10, outputTokens: 5 } },
  };
}

function judgeVerdict(passed: boolean, detail = "verdict") {
  return {
    chargeMinor: 3,
    providerCostEur: 0.001,
    response: {
      text: JSON.stringify({ criteria: [{ id: "quality", passed, detail }] }),
      usage: { inputTokens: 50, outputTokens: 20 },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  generateForUserMock.mockReset();
});

describe("porte de résultat (contrat déterministe)", () => {
  it("contrat satisfait dès la première vérification → completed, aucun cycle de correction", async () => {
    generateForUserMock.mockResolvedValue(stepText("Le marché croît de 40 % par an."));
    const runtime = new AgentRuntime({
      userId: "u1",
      objective: "note",
      plan: deliverablePlan(),
      outcomeContract: CONTRACT_CONTAINS,
    });
    const state = await runtime.run();
    expect(state.status).toBe("completed");
    expect(state.outcomeVerification?.passed).toBe(true);
    expect(generateForUserMock).toHaveBeenCalledTimes(1); // l'étape seulement
    expect(state.billing.totalChargeMinor).toBe(2);
  });

  it("critère manquant → passe de correction (feedback injecté) puis complétion si le livrable corrigé satisfait", async () => {
    generateForUserMock
      .mockResolvedValueOnce(stepText("Note sans chiffre."))
      .mockResolvedValueOnce(stepText("Le marché croît de 40 % par an."));
    const runtime = new AgentRuntime({
      userId: "u1",
      objective: "note",
      plan: deliverablePlan(),
      outcomeContract: CONTRACT_CONTAINS,
    });
    const state = await runtime.run();
    expect(state.status).toBe("completed");
    expect(state.outcomeVerification?.passed).toBe(true);
    expect(generateForUserMock).toHaveBeenCalledTimes(2);
    // Le verdict bloquant initial est persisté dans le checkpoint.
    const lastCheckpoint = mockedSaveCheckpoint.mock.calls.at(-1)?.[0];
    expect(lastCheckpoint?.outcomeVerification?.passed).toBe(true);
  });

  it("critère toujours manquant après la passe de correction → FAILED honnête (jamais « completed »)", async () => {
    generateForUserMock.mockResolvedValue(stepText("Note sans chiffre."));
    const runtime = new AgentRuntime({
      userId: "u1",
      objective: "note",
      plan: deliverablePlan(),
      outcomeContract: CONTRACT_CONTAINS,
    });
    const state = await runtime.run();
    expect(state.status).toBe("failed");
    expect(state.error).toContain("Critères d'acceptation non atteints");
    expect(state.outcomeVerification?.passed).toBe(false);
    // exactement 2 exécutions d'étape : initiale + une correction bornée
    expect(generateForUserMock).toHaveBeenCalledTimes(2);
  });

  it("failPolicy « fail » → aucun cycle de correction (échec immédiat)", async () => {
    generateForUserMock.mockResolvedValue(stepText("Note sans chiffre."));
    const runtime = new AgentRuntime({
      userId: "u1",
      objective: "note",
      plan: deliverablePlan(),
      outcomeContract: { ...CONTRACT_CONTAINS, failPolicy: "fail" },
    });
    const state = await runtime.run();
    expect(state.status).toBe("failed");
    expect(generateForUserMock).toHaveBeenCalledTimes(1);
  });
});

describe("porte de résultat (contrat sémantique — juge)", () => {
  it("juge favorable → completed ; usage du juge ajouté à la facturation", async () => {
    generateForUserMock.mockImplementation((input: { request: { messages: Array<{ role: string; content: string }> } }) => {
      const isJudge = input.request.messages[0].content.includes("vérificateur de contrats");
      return Promise.resolve(isJudge ? judgeVerdict(true) : stepText("Analyse du marché des agents autonomes."));
    });
    const runtime = new AgentRuntime({
      userId: "u1",
      objective: "note",
      plan: deliverablePlan(),
      outcomeContract: CONTRACT_JUDGE,
    });
    const state = await runtime.run();
    expect(state.status).toBe("completed");
    expect(state.outcomeVerification?.passed).toBe(true);
    expect(state.billing.totalChargeMinor).toBe(5); // étape (2) + juge (3)
  });

  it("juge défavorable puis favorable après correction → completed en 2 tours de livrable", async () => {
    let stepRun = 0;
    generateForUserMock.mockImplementation((input: { request: { messages: Array<{ role: string; content: string }> } }) => {
      const isJudge = input.request.messages[0].content.includes("vérificateur de contrats");
      if (isJudge) return Promise.resolve(judgeVerdict(stepRun >= 2, "analyse insuffisante" ));
      stepRun += 1;
      return Promise.resolve(stepText(`Analyse (v${stepRun}) du marché.`));
    });
    const runtime = new AgentRuntime({
      userId: "u1",
      objective: "note",
      plan: deliverablePlan(),
      outcomeContract: CONTRACT_JUDGE,
    });
    const state = await runtime.run();
    expect(state.status).toBe("completed");
    expect(stepRun).toBe(2);
    expect(state.outcomeVerification?.passed).toBe(true);
  });

  it("juge en panne → porte levée : mission complétée, verdict honnêtement unavailable", async () => {
    generateForUserMock.mockImplementation((input: { request: { messages: Array<{ role: string; content: string }> } }) => {
      const isJudge = input.request.messages[0].content.includes("vérificateur de contrats");
      if (isJudge) return Promise.reject(new Error("provider indisponible"));
      return Promise.resolve(stepText("Analyse du marché."));
    });
    const runtime = new AgentRuntime({
      userId: "u1",
      objective: "note",
      plan: deliverablePlan(),
      outcomeContract: CONTRACT_JUDGE,
    });
    const state = await runtime.run();
    expect(state.status).toBe("completed");
    expect(state.outcomeVerification?.unavailable).toBe(true);
    expect(state.error).toBeUndefined();
  });
});

describe("sans contrat de résultat (compatibilité historique)", () => {
  it("aucune vérification ajoutée : comportement et facturation inchangés", async () => {
    generateForUserMock.mockResolvedValue(stepText("Sortie d'étape."));
    const runtime = new AgentRuntime({ userId: "u1", objective: "note", plan: deliverablePlan() });
    const state = await runtime.run();
    expect(state.status).toBe("completed");
    expect(state.outcomeContract).toBeUndefined();
    expect(state.outcomeVerification).toBeUndefined();
    expect(generateForUserMock).toHaveBeenCalledTimes(1);
    expect(state.billing.totalChargeMinor).toBe(2);
  });
});

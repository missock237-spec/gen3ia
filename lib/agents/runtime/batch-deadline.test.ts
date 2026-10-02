import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tranche temporelle du runner (recommandation A — file d'attente mission) :
 * avec `batchDeadlineMs`, le runner refuse de LANCER un lot qui n'a pas la
 * place de se terminer avant l'échéance et se met en PAUSE PROPRE (chemin
 * PauseRequestedError éprouvé : checkpoint conservé, étapes restantes
 * « pending », aucun travail payant démarré au-delà de l'échéance). Sans
 * l'option, le comportement est strictement inchangé (toutes les intégrations
 * existantes : agent/chat, approve, continue).
 *
 * L'horloge est contrôlée : la mock de génération avance `Date.now` —
 * déterministe, aucun délai réel.
 */

const base = new Date("2026-01-01T00:00:00Z").getTime();
let clockOffset = 0;
let clockFrozen = false;

vi.mock("@/lib/billing/wallet", () => ({
  getWallet: vi.fn(async () => ({ availableMinor: 500_000, currency: "XAF" })),
  WALLET_CURRENCY: "XAF",
}));
vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: vi.fn(async () => {
    // Chaque appel LLM consomme 5 s d'horloge simulée (déterministe).
    clockOffset += 5_000;
    return {
      chargeMinor: 2,
      providerCostEur: 0.001,
      response: { text: "Sortie d'étape réelle simulée.", usage: { inputTokens: 10, outputTokens: 5 } },
    };
  }),
}));
vi.mock("./checkpoint", () => ({
  createCheckpoint: vi.fn(async () => undefined),
  saveCheckpoint: vi.fn(async () => undefined),
}));
vi.mock("./pause", async (importOriginal) => {
  const original = await importOriginal<typeof import("./pause")>();
  return {
    ...original,
    // Le contrôle Firestore de pause UTILISATEUR est neutralisé : la pause
    // testée ici ne doit RIEN devoir à un document de contrôle (elle naît
    // de l'échéance, sans écriture).
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
import { saveCheckpoint } from "./checkpoint";
import { generateForUser } from "@/lib/billing/ai-execution";

const mockedSaveCheckpoint = vi.mocked(saveCheckpoint);
const mockedGenerate = vi.mocked(generateForUser);

function plan(stepCount: number, maxConcurrency = 1): RuntimePlan {
  return {
    executionId: "exec-slice",
    objective: "Mission longue par tranches",
    steps: Array.from({ length: stepCount }, (_, index) => ({
      id: `s${index + 1}`,
      type: "llm" as const,
      name: `Étape ${index + 1}`,
      description: "Travail LLM",
      dependencies: index === 0 ? [] : [`s${index}`],
      status: "pending" as const,
      input: {},
      skillIds: [],
      maxRetries: 2,
      timeoutMs: 120_000,
      sideEffect: false,
      requiresApproval: false,
    })),
    maxConcurrency,
    maxIterations: 10,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clockOffset = 0;
  clockFrozen = false;
  // Le spy est REMIS en place à chaque test : restoreAllMocks ne doit jamais
  // laisser le clock simulé fuir (ni le subir) entre les tests.
  vi.spyOn(Date, "now").mockImplementation(() => (clockFrozen ? base : base + clockOffset));
});

afterEach(() => {
  vi.restoreAllMocks(); // restaure Date.now réel (le spy est réinstallé au beforeEach suivant)
});

describe("AgentRuntime — échéance de tranche (batchDeadlineMs)", () => {
  it("SANS l'option : comportement inchangé — la mission complète dans l'appel", async () => {
    const runtime = new AgentRuntime({ userId: "user-1", objective: "Mission longue par tranches", plan: plan(3) });
    const state = await runtime.run();
    expect(state.status).toBe("completed");
    expect(state.plan.steps.map((step) => step.status)).toEqual(["completed", "completed", "completed"]);
    expect(mockedGenerate).toHaveBeenCalledTimes(3);
  });

  it("échéance DÉJÀ dépassée → pause PROPRE avant tout travail payant", async () => {
    clockFrozen = true; // Date.now figé sur base : deadline = base - 1 est dépassée
    const runtime = new AgentRuntime({
      userId: "user-1",
      objective: "Mission longue par tranches",
      plan: plan(3),
      batchDeadlineMs: base - 1,
    });
    const state = await runtime.run();
    expect(state.status).toBe("paused");
    expect(state.plan.steps.every((step) => step.status === "pending")).toBe(true);
    expect(mockedGenerate).not.toHaveBeenCalled(); // AUCUN appel payant démarré
    // Le checkpoint est persisté avec l'état paused (reprise possible).
    expect(mockedSaveCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ status: "paused" }));
  });

  it("échéance atteinte APRÈS un lot → tranche exacte : le lot fini est conservé, le suivant n'est PAS lancé", async () => {
    // Budget : deadline = base + 46 000 ; réserve par défaut 45 000.
    // Lot 1 (offset 0) : 0 + 45 000 ≤ 46 000 → lancé ; la génération avance
    // l'horloge de 5 000 → lot 2 : 5 000 + 45 000 = 50 000 > 46 000 → PAUSE.
    const runtime = new AgentRuntime({
      userId: "user-1",
      objective: "Mission longue par tranches",
      plan: plan(3),
      batchDeadlineMs: base + 46_000,
    });
    const state = await runtime.run();
    expect(state.status).toBe("paused");
    expect(state.plan.steps.map((step) => step.status)).toEqual(["completed", "pending", "pending"]);
    // Le travail payé est conservé pour la reprise (checkpoint + outputs).
    expect(state.outputs.s1).toBe("Sortie d'étape réelle simulée.");
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(mockedSaveCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ status: "paused" }));
  });

  it("réserve personnalisée (minBatchReserveMs) : un lot démarré garde la place de finir", async () => {
    // Réserve 1 000 ms, deadline base + 12 000 :
    // lot 1 : 0 + 1 000 ≤ 12 000 → lancé (offset → 5 000) ;
    // lot 2 : 5 000 + 1 000 = 6 000 ≤ 12 000 → lancé (offset → 10 000) ;
    // lot 3 : 10 000 + 1 000 = 11 000 ≤ 12 000 → lancé (offset → 15 000) ;
    // plan terminé → completed.
    const runtime = new AgentRuntime({
      userId: "user-1",
      objective: "Mission longue par tranches",
      plan: plan(3),
      batchDeadlineMs: base + 12_000,
      minBatchReserveMs: 1_000,
    });
    const state = await runtime.run();
    expect(state.status).toBe("completed");
    expect(state.plan.steps.every((step) => step.status === "completed")).toBe(true);
    expect(mockedGenerate).toHaveBeenCalledTimes(3);
  });
});

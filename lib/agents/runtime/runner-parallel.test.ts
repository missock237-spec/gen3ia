import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PARALLÉLISATION RÉELLE DU DAG (Task 124 — vitesse maximale) : la vague
 * CONTINUE du runner démarre un nœud prêt DÈS qu'un slot de concurrence se
 * libère, sans attendre la fin de la vague (l'ancienne barrière Promise.all
 * bloquait des branches indépendantes derrière la plus lente). Contrats
 * vérifiés (chronométrage réel, marges larges — déterministe en ordre) :
 *  - un nœud indépendant démarre PENDANT l'exécution d'une branche lente
 *    concurrente (avant : il attendait la fin de la vague entière) ;
 *  - l'ordre topologique est respecté (un nœud n'attend que ses dépendances,
 *    et les branches sœurs partent ensemble) ;
 *  - la concurrence reste bornée par plan.maxConcurrency.
 *
 * Le budget de tranche (batchDeadlineMs) reste couvert par
 * batch-deadline.test.ts (pause propre avant tout travail payant).
 */

/** Durée simulée par étape (ms) — marges larges pour la stabilité CI. */
const STEP_DURATIONS: Record<string, number> = {
  "fast-a": 5,
  "fast-b": 5,
  fast: 5,
  root: 5,
  slow: 80,
  join: 5,
};

interface StepEvent {
  stepId: string;
  startedAt: number;
  endedAt: number;
}

const events: StepEvent[] = [];
let observedConcurrency = 0;
const runningSteps = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

vi.mock("@/lib/billing/wallet", () => ({
  getWallet: vi.fn(async () => ({ availableMinor: 500_000, currency: "XAF" })),
  WALLET_CURRENCY: "XAF",
}));
vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: vi.fn(async (input: { request: { messages: Array<{ role: string; content: string }> } }) => {
    const userMessage = [...input.request.messages].reverse().find((message) => message.role === "user");
    let stepId = "unknown";
    try {
      const parsed = JSON.parse(userMessage?.content ?? "{}") as { step?: { id?: string } };
      if (typeof parsed.step?.id === "string") stepId = parsed.step.id;
    } catch {
      /* étape sans identifiant parsable : durée par défaut */
    }
    const startedAt = Date.now();
    runningSteps.add(stepId);
    observedConcurrency = Math.max(observedConcurrency, runningSteps.size);
    await sleep(STEP_DURATIONS[stepId] ?? 5);
    runningSteps.delete(stepId);
    events.push({ stepId, startedAt, endedAt: Date.now() });
    return {
      chargeMinor: 2,
      providerCostEur: 0.001,
      response: { text: `Sortie de ${stepId}.`, usage: { inputTokens: 10, outputTokens: 5 } },
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
    assertNotPaused: vi.fn(async () => undefined),
    assertNotStopped: vi.fn(async () => undefined),
  };
});
vi.mock("@/lib/agents/repository", () => ({ getAgentForOwner: vi.fn(async () => null) }));
vi.mock("@/lib/security/execution-policy", () => ({
  DEFAULT_EXECUTION_POLICY: { maxConcurrency: 4, maxTotalRetries: 15, budgetEurMinor: 500 },
  ExecutionPolicy: class {},
}));

import { AgentRuntime, type RuntimePlan, type RuntimeStep } from "./runner";

function step(id: string, dependencies: string[] = []): RuntimeStep {
  return {
    id,
    type: "llm",
    name: `Étape ${id}`,
    description: `Travail ${id}`,
    dependencies,
    status: "pending",
    input: {},
    skillIds: [],
    maxRetries: 2,
    timeoutMs: 120_000,
    sideEffect: false,
    requiresApproval: false,
  };
}

function plan(steps: RuntimeStep[], maxConcurrency: number): RuntimePlan {
  return {
    executionId: "exec-parallel",
    objective: "DAG parallèle",
    steps,
    maxConcurrency,
    maxIterations: 20,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  observedConcurrency = 0;
  runningSteps.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentRuntime — DAG parallèle (vague continue, Task 124)", () => {
  it("démarre un nœud prêt DÈS qu'un slot se libère (pas de barrière de vague)", async () => {
    // Trois branches indépendantes (fast 5 ms, slow 80 ms, fast 5 ms) sous
    // concurrence 2 : l'ancienne barrière attendait la fin de `slow` (~80 ms)
    // avant de lancer le second `fast` ; la vague continue le lance dès la
    // libération du slot par le premier `fast` (~5 ms).
    const runtime = new AgentRuntime({
      userId: "user-1",
      objective: "DAG parallèle",
      plan: plan([step("fast-a"), step("slow"), step("fast-b")], 2),
    });
    const state = await runtime.run();

    expect(state.status).toBe("completed");
    expect(state.plan.steps.map((step) => step.status)).toEqual(["completed", "completed", "completed"]);

    const fastB = events.find((event) => event.stepId === "fast-b");
    const slow = events.find((event) => event.stepId === "slow");
    expect(fastB).toBeDefined();
    expect(slow).toBeDefined();
    // fast-b démarre PENDANT l'exécution de slow (avant sa fin) : la branche
    // lente ne bloque plus les branches indépendantes déjà prêtes.
    expect(fastB!.startedAt).toBeLessThan(slow!.endedAt);
  });

  it("respecte l'ordre topologique : un nœud n'attend que ses dépendances", async () => {
    // root → (slow, fast) → join : `join` ne démarre qu'après slow ET fast ;
    // les deux branches sœurs partent ENSEMBLE après root.
    const runtime = new AgentRuntime({
      userId: "user-1",
      objective: "DAG parallèle",
      plan: plan([step("root"), step("slow", ["root"]), step("fast", ["root"]), step("join", ["slow", "fast"])], 3),
    });
    const state = await runtime.run();

    expect(state.status).toBe("completed");
    expect(state.plan.steps.map((step) => step.status)).toEqual(["completed", "completed", "completed", "completed"]);
    const byId = new Map(events.map((event) => [event.stepId, event]));
    const root = byId.get("root")!;
    const slow = byId.get("slow")!;
    const fast = byId.get("fast")!;
    const join = byId.get("join")!;
    expect(root.endedAt).toBeLessThanOrEqual(slow.startedAt);
    expect(root.endedAt).toBeLessThanOrEqual(fast.startedAt);
    expect(slow.endedAt).toBeLessThanOrEqual(join.startedAt);
    expect(fast.endedAt).toBeLessThanOrEqual(join.startedAt);
    // Les deux branches partent en parallèle (même créneau de démarrage).
    expect(Math.abs(slow.startedAt - fast.startedAt)).toBeLessThan(20);
  });

  it("borne la concurrence au plafond du plan (jamais plus de slots que maxConcurrency)", async () => {
    // Quatre branches indépendantes sous concurrence 2 : le chevauchement
    // observé ne dépasse JAMAIS 2 (les slots libérés relancent, jamais plus).
    const runtime = new AgentRuntime({
      userId: "user-1",
      objective: "DAG parallèle",
      plan: plan([step("root"), step("slow"), step("fast"), step("join")], 2),
    });
    const state = await runtime.run();

    expect(state.status).toBe("completed");
    expect(observedConcurrency).toBeLessThanOrEqual(2);
    expect(observedConcurrency).toBeGreaterThan(1); // le parallélisme est RÉEL
  });
});

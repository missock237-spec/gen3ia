import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AUTO-ÉVOLUTION (concept #10 « Self-Evolving Platform ») : classement pur
 * des échecs, forage de clusters (transaction atomique, fail-soft), brief de
 * leçons injecté dans les replanifications. REPLANIFICATION DYNAMIQUE :
 * plan réécrit à partir du contexte réel (réussies + échecs + leçons), DAG
 * linéaire, étapes réussies conservées, facturation réelle.
 */

const runTransaction = vi.fn();
const clusterDocGet = vi.fn();
const clusterDocSet = vi.fn();
const clusterDocUpdate = vi.fn();
const queryGet = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  FieldValue: { increment: (n: number) => ({ __increment: n }), serverTimestamp: () => ({ __ts: true }) },
  adminDb: {
    collection: vi.fn((name: string) => ({
      doc: vi.fn(() => ({ get: clusterDocGet, set: clusterDocSet, update: clusterDocUpdate })),
      ...(name === "agentFailureClusters"
        ? { where: vi.fn(() => ({ orderBy: vi.fn(() => ({ limit: vi.fn(() => ({ get: (...args: unknown[]) => queryGet(...args) })) })) })) }
        : {}),
    })),
    runTransaction: (...args: unknown[]) => runTransaction(...args),
  },
}));

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { increment: (n: number) => ({ __increment: n }), serverTimestamp: () => ({ __ts: true }) },
}));

const generateForUserMock = vi.fn();
vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: (...args: unknown[]) => generateForUserMock(...args),
}));

import { classifyFailure, failureClusterId, getEvolutionBrief, recordFailureClusters } from "./evolution";
import { buildReplan, buildReplanContext } from "./runtime/replan";
import type { RuntimeExecutionState } from "./runtime/types";

function failingState(): RuntimeExecutionState {
  return {
    executionId: "exec-1",
    userId: "u1",
    objective: "Publier un article hebdo",
    status: "failed",
    error: "Tool not allowed: social.publish",
    plan: {
      executionId: "exec-1",
      objective: "Publier un article hebdo",
      steps: [
        { id: "s1", type: "llm", name: "Rédaction", description: "Rédiger l'article", dependencies: [], status: "completed", input: {}, skillIds: [], maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false },
        { id: "s2", type: "tool", name: "Publication", description: "Publier", dependencies: ["s1"], status: "failed", input: {}, skillIds: [], maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false, toolName: "social.publish" },
      ],
      maxConcurrency: 2,
      maxIterations: 10,
    },
    observations: [
      { stepId: "s2", success: false, error: "Tool not allowed: social.publish", latencyMs: 5, timestamp: "t" },
    ],
    evaluations: [],
    outputs: { s1: "Article rédigé." },
    iteration: 3,
    totalRetries: 0,
    maxTotalRetries: 15,
    billing: { currency: "XAF", totalChargeMinor: 0, totalProviderCostEur: 0, llmInputTokens: 0, llmOutputTokens: 0 },
  };
}

beforeEach(() => {
  runTransaction.mockReset();
  clusterDocGet.mockReset();
  clusterDocSet.mockReset();
  clusterDocUpdate.mockReset();
  queryGet.mockReset();
  generateForUserMock.mockReset();
});

describe("classification des échecs (pure)", () => {
  it("classe les familles connues ; inconnu → other", () => {
    expect(classifyFailure("Step timeout after 120000ms")).toBe("timeout");
    expect(classifyFailure("Insufficient wallet balance.")).toBe("insufficient_funds");
    expect(classifyFailure("Permission denied: tool.external")).toBe("permission_denied");
    expect(classifyFailure("Unknown tool: foo.bar")).toBe("tool_missing");
    expect(classifyFailure("provider indisponible (429)")).toBe("provider_error");
    expect(classifyFailure("Code execution requires input.code")).toBe("input_invalid");
    expect(classifyFailure("une panne mystérieuse")).toBe("other");
  });

  it("cluster id : stable par (utilisateur, type, outil, classe), distinct entre utilisateurs", () => {
    const base = { userId: "u1", stepType: "tool", toolName: "web.search", errorClass: "timeout" };
    expect(failureClusterId(base)).toBe(failureClusterId({ ...base }));
    expect(failureClusterId(base)).not.toBe(failureClusterId({ ...base, userId: "u2" }));
    expect(failureClusterId(base)).not.toBe(failureClusterId({ ...base, errorClass: "other" }));
  });
});

describe("forage de clusters", () => {
  it("incrémente le cluster existant de façon atomique", async () => {
    clusterDocGet.mockResolvedValue({ exists: true });
    runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
      fn({ get: (ref: unknown) => clusterDocGet(ref), update: (_ref: unknown, data: unknown) => clusterDocUpdate(data), set: (_ref: unknown, data: unknown) => clusterDocSet(data) }));
    clusterDocUpdate.mockResolvedValue(undefined);
    const written = await recordFailureClusters(failingState());
    expect(written).toBe(1);
    expect(clusterDocUpdate).toHaveBeenCalledWith(expect.objectContaining({ occurrences: { __increment: 1 }, lastExecutionId: "exec-1" }));
    expect(clusterDocSet).not.toHaveBeenCalled();
  });

  it("crée le cluster au premier échec avec échantillon", async () => {
    clusterDocGet.mockResolvedValue({ exists: false });
    runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
      fn({ get: (ref: unknown) => clusterDocGet(ref), update: (_ref: unknown, data: unknown) => clusterDocUpdate(data), set: (_ref: unknown, data: unknown) => clusterDocSet(data) }));
    clusterDocSet.mockResolvedValue(undefined);
    await recordFailureClusters(failingState());
    expect(clusterDocSet).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      stepType: "tool",
      toolName: "social.publish",
      errorClass: expect.any(String),
      occurrences: 1,
      sampleStepName: "Publication",
    }));
  });

  it("mission sans échec → zéro écriture ; panne Firestore → fail-soft", async () => {
    const okState = failingState();
    okState.plan.steps[1].status = "completed";
    expect(await recordFailureClusters(okState)).toBe(0);
    runTransaction.mockRejectedValue(new Error("firestore down"));
    expect(await recordFailureClusters(failingState())).toBe(0);
  });
});

describe("brief d'évolution", () => {
  it("clusters → bloc de leçons compact ; lecture vide → texte vide", async () => {
    queryGet.mockResolvedValue({
      docs: [
        { data: () => ({ errorClass: "tool_missing", stepType: "tool", toolName: "social.publish", occurrences: 4, sampleMessage: "Tool not allowed" }) },
      ],
    });
    const brief = await getEvolutionBrief("u1");
    expect(brief.clusters).toHaveLength(1);
    expect(brief.text).toContain("tool_missing");
    expect(brief.text).toContain("4×");
    queryGet.mockResolvedValue({ docs: [] });
    const empty = await getEvolutionBrief("u1");
    expect(empty.text).toBe("");
  });
});

describe("replanification dynamique", () => {
  it("contexte réel : réussies avec résumé, échecs avec erreur", () => {
    const context = buildReplanContext(failingState());
    expect(context.completed).toEqual([{ name: "Rédaction", summary: "Article rédigé." }]);
    expect(context.failed[0].name).toBe("Publication");
    expect(context.failed[0].error).toContain("not allowed");
  });

  it("plan replanifié : réussies conservées + étapes linéaires + leçons injectées + usage facturé", async () => {
    queryGet.mockResolvedValue({
      docs: [{ data: () => ({ errorClass: "tool_missing", stepType: "tool", toolName: "social.publish", occurrences: 3, sampleMessage: "Tool not allowed" }) }],
    });
    generateForUserMock.mockResolvedValue({
      chargeMinor: 4,
      providerCostEur: 0.002,
      response: {
        text: JSON.stringify({
          reasoning: "publication impossible — produire un projet de post + instructions manuelles",
          steps: [
            { type: "llm", name: "Projet de post", description: "Rédige le post final prêt à publier" },
            { type: "llm", name: "Notice de publication", description: "Liste les étapes de publication manuelle avec les garde-fous" },
          ],
        }),
        usage: { inputTokens: 200, outputTokens: 80 },
      },
    });
    const state = failingState();
    const { plan, usage } = await buildReplan(state, { userId: "u1", executionId: "exec-1" });
    expect(usage.chargeMinor).toBe(4);
    // les réussies sont conservées à l'identique
    expect(plan.steps[0].id).toBe("s1");
    expect(plan.steps[0].status).toBe("completed");
    // nouvelles étapes linéaires (DAG sans cycle)
    const replanned = plan.steps.filter((step) => step.id.startsWith("replan_"));
    expect(replanned).toHaveLength(2);
    expect(replanned[0].dependencies).toEqual([]);
    expect(replanned[1].dependencies).toEqual([replanned[0].id]);
    expect(replanned.every((step) => step.sideEffect === false)).toBe(true);
    // leçons injectées dans le prompt
    const payload = JSON.parse(generateForUserMock.mock.calls[0][0].request.messages[1].content);
    expect(payload.ecueilsConnus).toContain("tool_missing");
    expect(payload.stepsEnEchec[0].error).toContain("not allowed");
  });

  it("juge en panne → exception propagée (échec honnête conservé par le runner)", async () => {
    generateForUserMock.mockRejectedValue(new Error("provider down"));
    await expect(buildReplan(failingState(), { userId: "u1", executionId: "exec-1" })).rejects.toThrow("provider down");
  });
});

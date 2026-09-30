import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Étape 2 du plan 20 — « le système d'agent IA ne traite pas les tâches
 * longues ». La route /api/agent/chat/continue reprend une mission
 * interrompue (timeout, kill plateforme) : les étapes réussies sont
 * SAUTÉES et leurs sorties nourrissent à nouveau les étapes dépendantes ;
 * seules les étapes restantes s'exécutent.
 */

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/security/rate-limit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("@/lib/agents/runtime/checkpoint", () => ({ loadCheckpoint: vi.fn() }));
vi.mock("@/lib/chat/repository", () => ({ appendMessage: vi.fn() }));
vi.mock("@/lib/agents/conversation-run", () => ({ reconcileAgentRun: vi.fn(), recordAgentRun: vi.fn() }));
const mockRun = vi.fn();
const mockConstructorCalls: Array<Record<string, unknown>> = [];
vi.mock("@/lib/agents/runtime/runner", () => ({
  AgentRuntime: vi.fn(function AgentRuntimeMock(options: Record<string, unknown>) {
    mockConstructorCalls.push(options);
    return { run: mockRun };
  }),
}));

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { loadCheckpoint } from "@/lib/agents/runtime/checkpoint";
import { appendMessage } from "@/lib/chat/repository";
import { reconcileAgentRun } from "@/lib/agents/conversation-run";
import { POST } from "./route";

const mockedRequireUser = vi.mocked(requireUser);
const mockedEnforce = vi.mocked(enforceRateLimit);
const mockedLoadCheckpoint = vi.mocked(loadCheckpoint);
const mockedAppend = vi.mocked(appendMessage);
const mockedReconcile = vi.mocked(reconcileAgentRun);

const BASE_PLAN = {
  executionId: "exec-long",
  objective: "Rapport long multi-étapes",
  steps: [
    { id: "s1", type: "llm" as const, name: "Recherche", description: "Chercher", dependencies: [], status: "completed" as const, input: {}, skillIds: [] as string[], maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false },
    { id: "s2", type: "llm" as const, name: "Analyse", description: "Analyser", dependencies: ["s1"], status: "failed" as const, input: {}, skillIds: [] as string[], maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false },
    { id: "s3", type: "llm" as const, name: "Rédaction", description: "Rédiger", dependencies: ["s2"], status: "pending" as const, input: {}, skillIds: [] as string[], maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false },
  ],
  maxConcurrency: 1,
  maxIterations: 5,
};

const COMPLETED_PLAN = {
  executionId: "exec-long",
  objective: "Rapport long multi-étapes",
  steps: [
    { id: "s1", type: "llm" as const, name: "Recherche", description: "Chercher", dependencies: [], status: "completed" as const, input: {}, skillIds: [] as string[], maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false },
    { id: "s2", type: "llm" as const, name: "Analyse", description: "Analyser", dependencies: ["s1"], status: "completed" as const, input: {}, skillIds: [] as string[], maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false },
    { id: "s3", type: "llm" as const, name: "Rédaction", description: "Rédiger", dependencies: ["s2"], status: "completed" as const, input: {}, skillIds: [] as string[], maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false },
  ],
  maxConcurrency: 1,
  maxIterations: 5,
};

function checkpoint(overrides: Record<string, unknown> = {}) {
  return {
    executionId: "exec-long",
    userId: "user-1",
    objective: "Rapport long multi-étapes",
    conversationId: "conv-1",
    status: "failed" as const,
    plan: BASE_PLAN,
    observations: [],
    evaluations: [],
    outputs: { s1: "Résultats de la recherche conservés." },
    iteration: 2,
    totalRetries: 1,
    maxTotalRetries: 15,
    billing: { currency: "XAF", totalChargeMinor: 12, totalProviderCostEur: 0.02, llmInputTokens: 900, llmOutputTokens: 400 },
    startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("https://gen3ia.local/api/agent/chat/continue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConstructorCalls.length = 0;
  mockedRequireUser.mockResolvedValue({ uid: "user-1" } as never);
  mockedEnforce.mockResolvedValue({ allowed: true, remaining: 19, retryAfterMs: 0, distributed: true } as never);
  mockedLoadCheckpoint.mockResolvedValue(checkpoint() as never);
  mockedAppend.mockResolvedValue({ id: "saved-1" } as never);
  mockedReconcile.mockResolvedValue(undefined as never);
  mockRun.mockResolvedValue({
    status: "completed",
    executionId: "exec-long",
    objective: "Rapport long multi-étapes",
    plan: COMPLETED_PLAN,
    observations: [],
    outputs: { s1: "Résultats de la recherche conservés.", s2: "Analyse refaite.", s3: "Rapport final complet." },
    billing: { currency: "XAF", totalChargeMinor: 20, totalProviderCostEur: 0.03, llmInputTokens: 1500, llmOutputTokens: 800 },
  });
});

describe("POST /api/agent/chat/continue — reprise des missions longues", () => {
  it("reprend la mission : étapes failed/réinitialisées, complétées SAUTÉES, sorties restaurées", async () => {
    const response = await POST(postRequest({ executionId: "exec-long" }));
    expect(response.status).toBe(200);
    const runtimeOptions = mockConstructorCalls[0] ?? {};
    const plan = runtimeOptions.plan as typeof BASE_PLAN;
    // s2 (failed) et s3 (pending) repartent ; s1 (completed) est sauté.
    expect(plan.steps.find((s) => s.id === "s1")?.status).toBe("completed");
    expect(plan.steps.find((s) => s.id === "s2")?.status).toBe("pending");
    expect(plan.steps.find((s) => s.id === "s3")?.status).toBe("pending");
    // Les sorties du travail déjà payé nourrissent les étapes dépendantes.
    expect(runtimeOptions.initialOutputs).toMatchObject({ s1: "Résultats de la recherche conservés." });
    // Le résultat final est persisté dans le fil.
    expect(mockedAppend).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv-1",
      role: "assistant",
      content: "Rapport final complet.",
    }));
    // Le run lié au fil est réconcilié avec le statut final.
    expect(mockedReconcile).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv-1",
      status: "completed",
      finalText: "Rapport final complet.",
    }));
  });

  it("expose resumed:true et resumable:false quand la reprise aboutit", async () => {
    const response = await POST(postRequest({ executionId: "exec-long" }));
    const body = await response.json();
    expect(body.resumed).toBe(true);
    expect(body.resumable).toBe(false);
    expect(body.status).toBe("completed");
    expect(body.finalText).toBe("Rapport final complet.");
  });

  it("une reprise qui ré-échoue reste elle-même reprenable (jamais de blocage définitif)", async () => {
    mockRun.mockRejectedValue(new Error("Execution time budget exhausted"));
    const response = await POST(postRequest({ executionId: "exec-long" }));
    const body = await response.json();
    expect(body.status).toBe("failed");
    expect(body.resumable).toBe(true);
    expect(body.executionId).toBe("exec-long");
  });

  it("HONNÊTETÉ : une reprise avec échec résiduel annonce « Mission incomplète », jamais « livré »", async () => {
    mockRun.mockResolvedValue({
      status: "failed",
      executionId: "exec-long",
      objective: "Rapport long multi-étapes",
      plan: { ...COMPLETED_PLAN, steps: COMPLETED_PLAN.steps.map((s) => (s.id === "s3" ? { ...s, status: "failed" as const } : s)) },
      observations: [],
      outputs: { s1: "Recherche OK.", s2: "Analyse OK." },
      error: "étape rédaction échouée",
      billing: { currency: "XAF", totalChargeMinor: 20, totalProviderCostEur: 0.03, llmInputTokens: 1500, llmOutputTokens: 800 },
    });
    const response = await POST(postRequest({ executionId: "exec-long" }));
    const body = await response.json();
    expect(body.status).toBe("failed");
    // Contrat : un échec n'expose PAS de finalText (pas de texte de livraison)
    // — l'honnêteté passe par le message persisté dans le fil.
    expect(body.finalText).toBeUndefined();
    expect(mockedAppend).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("Mission incomplète"),
    }));
  });

  it("404 sur une mission inconnue ou appartenant à un autre utilisateur", async () => {
    mockedLoadCheckpoint.mockResolvedValue(null as never);
    const response = await POST(postRequest({ executionId: "exec-inconnu" }));
    expect(response.status).toBe(404);
  });

  it("409 sur une mission terminée : pas de double exécution", async () => {
    mockedLoadCheckpoint.mockResolvedValue(checkpoint({ status: "completed" }) as never);
    const response = await POST(postRequest({ executionId: "exec-long" }));
    expect(response.status).toBe(409);
    expect(mockConstructorCalls).toHaveLength(0);
  });

  it("409 sur une mission arrêtée définitivement par l'utilisateur", async () => {
    mockedLoadCheckpoint.mockResolvedValue(checkpoint({ status: "cancelled" }) as never);
    const response = await POST(postRequest({ executionId: "exec-long" }));
    expect(response.status).toBe(409);
  });

  it("409 sur un `running` FRAIS (< 10 min) : la mission tourne encore", async () => {
    mockedLoadCheckpoint.mockResolvedValue(checkpoint({
      status: "running",
      startedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    }) as never);
    const response = await POST(postRequest({ executionId: "exec-long" }));
    expect(response.status).toBe(409);
  });

  it("REPRED un `running` STALE (> 10 min) : fonction tuée par la plateforme", async () => {
    mockedLoadCheckpoint.mockResolvedValue(checkpoint({
      status: "running",
      startedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    }) as never);
    const response = await POST(postRequest({ executionId: "exec-long" }));
    expect(response.status).toBe(200);
    expect(mockRun).toHaveBeenCalledOnce();
  });

  it("409 si une étape attend une approbation (le flux HITL reste la seule voie)", async () => {
    const waitingPlan = { ...BASE_PLAN, steps: BASE_PLAN.steps.map((s) => (s.id === "s2" ? { ...s, status: "waiting_approval" as const } : s)) };
    mockedLoadCheckpoint.mockResolvedValue(checkpoint({ status: "failed", plan: waitingPlan }) as never);
    const response = await POST(postRequest({ executionId: "exec-long" }));
    expect(response.status).toBe(409);
    expect(mockConstructorCalls).toHaveLength(0);
  });

  it("401 structuré sans session", async () => {
    mockedRequireUser.mockRejectedValue(
      Object.assign(new Error("Authentification requise : jeton manquant ou session expirée."), { status: 401, code: "AUTH_REQUIRED" }),
    );
    const response = await POST(postRequest({ executionId: "exec-long" }));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.code).toBe("AUTH_REQUIRED");
  });
});

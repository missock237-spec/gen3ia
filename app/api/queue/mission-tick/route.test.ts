import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Receiver QStash /api/queue/mission-tick (recommandation A de l'audit).
 * Tests COMPORTEMENTAUX : signature = authentification, claim = un seul
 * worker, échéance = ré-enfilement, échec métier = terminaison sans
 * redélivrance (jamais de double facturation), échec infra = 5xx (redélivrance).
 */

vi.mock("@/lib/queue/qstash", () => ({
  qstashConfig: vi.fn(),
  verifyUpstashSignature: vi.fn(),
  publishMissionTick: vi.fn(),
}));
vi.mock("@/lib/queue/mission-queue", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/queue/mission-queue")>();
  return {
    ...original,
    claimMissionTick: vi.fn(),
    persistMissionProgress: vi.fn(),
    finalizeMissionRun: vi.fn(),
  };
});
vi.mock("@/lib/agents/runtime/runner", () => ({
  AgentRuntime: vi.fn(function AgentRuntimeMock(options: Record<string, unknown>) {
    mockConstructorCalls.push(options);
    return { run: mockRun };
  }),
}));
vi.mock("@/lib/agents/runtime/checkpoint", () => ({ loadCheckpoint: vi.fn() }));
vi.mock("@/lib/agents/runtime/pause", () => ({ isExecutionPauseRequested: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  executionLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }),
  safeError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
}));

import { AgentRuntime } from "@/lib/agents/runtime/runner";
import { loadCheckpoint } from "@/lib/agents/runtime/checkpoint";
import { isExecutionPauseRequested } from "@/lib/agents/runtime/pause";
import {
  claimMissionTick,
  finalizeMissionRun,
  persistMissionProgress,
  NEXT_TICK_DELAY_SECONDS,
} from "@/lib/queue/mission-queue";
import { publishMissionTick, qstashConfig, verifyUpstashSignature } from "@/lib/queue/qstash";
import { POST } from "./route";

const mockedQstashConfig = vi.mocked(qstashConfig);
const mockedVerify = vi.mocked(verifyUpstashSignature);
const mockedPublish = vi.mocked(publishMissionTick);
const mockedClaim = vi.mocked(claimMissionTick);
const mockedProgress = vi.mocked(persistMissionProgress);
const mockedFinalize = vi.mocked(finalizeMissionRun);
const mockedLoadCheckpoint = vi.mocked(loadCheckpoint);
const mockedUserPause = vi.mocked(isExecutionPauseRequested);
const mockRun = vi.fn();
const mockConstructorCalls: Array<Record<string, unknown>> = [];

const RUN_ID = "0f0e0d0c-1111-2222-3333-444455556666";
const EXEC_ID = "aa11bb22-cc33-dd44-ee55-ff6677889900";

const PLAN = {
  executionId: EXEC_ID,
  objective: "Étude de marché complète",
  steps: [
    { id: "s1", type: "llm" as const, name: "Recherche", description: "d", dependencies: [], status: "pending" as const, input: {}, skillIds: [] as string[], maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false },
    { id: "s2", type: "llm" as const, name: "Rédaction", description: "d", dependencies: ["s1"], status: "pending" as const, input: {}, skillIds: [] as string[], maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false },
  ],
  maxConcurrency: 1,
  maxIterations: 10,
};

const CLAIMED = {
  kind: "claimed" as const,
  record: {
    runId: RUN_ID, userId: "user-1", executionId: EXEC_ID, objective: "Étude de marché complète",
    status: "running" as const, attempts: 1, leaseUntilMs: Date.now() + 90_000,
    plan: PLAN, timeline: [], pendingCount: 2, createdAtMs: 1, updatedAtMs: 2,
  },
};

function tickRequest(rawBody: string, signature = "v1,abc"): NextRequest {
  return new NextRequest("https://gen3ia.local/api/queue/mission-tick", {
    method: "POST",
    headers: { "content-type": "application/json", "upstash-signature": signature },
    body: rawBody,
  });
}

function pausedState(stepStatus: "pending" | "completed" = "pending") {
  return {
    status: "paused" as const,
    executionId: EXEC_ID,
    objective: "Étude de marché complète",
    plan: { ...PLAN, steps: PLAN.steps.map((step, index) => ({ ...step, status: index === 0 ? stepStatus : step.status })) },
    observations: [], evaluations: [], outputs: stepStatus === "completed" ? { s1: "Sortie" } : {},
    iteration: 1, totalRetries: 0, maxTotalRetries: 15,
    billing: { currency: "XAF", totalChargeMinor: 4, totalProviderCostEur: 0.01, llmInputTokens: 100, llmOutputTokens: 50 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConstructorCalls.length = 0;
  mockedQstashConfig.mockReturnValue({ token: "tok", currentSigningKey: "k1", nextSigningKey: "k2" });
  mockedVerify.mockReturnValue(true);
  mockedPublish.mockResolvedValue({ messageId: "msg-1" });
  mockedClaim.mockResolvedValue(structuredClone(CLAIMED));
  mockedProgress.mockResolvedValue(undefined);
  mockedFinalize.mockResolvedValue(undefined);
  mockedLoadCheckpoint.mockResolvedValue(null);
  mockedUserPause.mockResolvedValue(false);
  mockRun.mockResolvedValue(pausedState());
});

describe("POST /api/queue/mission-tick — sécurité du receiver", () => {
  it("503 quand la file n'est pas configurée (aucune signature vérifiable)", async () => {
    mockedQstashConfig.mockReturnValue(null);
    const response = await POST(tickRequest(JSON.stringify({ runId: RUN_ID })));
    expect(response.status).toBe(503);
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it("401 sur signature invalide — AVANT tout traitement métier", async () => {
    mockedVerify.mockReturnValue(false);
    const response = await POST(tickRequest(JSON.stringify({ runId: RUN_ID })));
    expect(response.status).toBe(401);
    expect(mockedClaim).not.toHaveBeenCalled();
    expect(AgentRuntime).not.toHaveBeenCalled();
  });

  it("401 sans header de signature", async () => {
    mockedVerify.mockImplementation((_config, _body, header) => header === "v1,valid");
    const response = await POST(new NextRequest("https://gen3ia.local/api/queue/mission-tick", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: RUN_ID }),
    }));
    expect(response.status).toBe(401);
  });

  it("413 sur corps anormalement volumineux (défense avant parsing)", async () => {
    const response = await POST(tickRequest(`{"pad":"${"x".repeat(10_000)}"}`));
    expect(response.status).toBe(413);
  });

  it("400 sur charge utile invalide (runId absent ou mal formé)", async () => {
    for (const body of [JSON.stringify({}), JSON.stringify({ runId: "../etc" }), "not-json"]) {
      const response = await POST(tickRequest(body));
      expect(response.status).toBe(400);
    }
    expect(mockedClaim).not.toHaveBeenCalled();
  });
});

describe("POST /api/queue/mission-tick — no-op sans ré-exécution", () => {
  it("200 skipped sur document absent / bail actif / statut terminal — jamais d'AgentRuntime", async () => {
    for (const claim of [
      { kind: "missing" as const },
      { kind: "lease-held" as const },
      { kind: "terminal" as const, status: "completed" as const },
    ]) {
      mockedClaim.mockResolvedValueOnce(claim as never);
      const response = await POST(tickRequest(JSON.stringify({ runId: RUN_ID })));
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.skipped).toBe(claim.kind);
    }
    expect(mockRun).not.toHaveBeenCalled();
  });
});

describe("POST /api/queue/mission-tick — tranche d'exécution", () => {
  it("échéance de tranche → ré-enfilement : bail relâché AVANT le publish, délai appliqué", async () => {
    const state = pausedState();
    mockRun.mockResolvedValue(state);
    const response = await POST(tickRequest(JSON.stringify({ runId: RUN_ID })));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.reenqueued).toBe(true);
    // Le runtime a reçu l'échéance horloge (50 s) et le plan du record (pas de checkpoint au 1er tick).
    const options = mockConstructorCalls[0];
    expect(options.batchDeadlineMs).toBeGreaterThan(Date.now() + 40_000);
    expect(options.plan).toEqual(PLAN);
    expect(options.initialOutputs).toBeUndefined();
    // Progression persistée pendant le tick.
    expect(mockedProgress).toHaveBeenCalledWith(RUN_ID, state.plan.steps);
    // ORDRE CRITIQUE : finalisation (bail relâché) PUIS publish — un échec
    // de publish laisse alors QStash re-tenter un claim possible.
    // ORIGINE CANONIQUE : le publish ne reçoit PLUS d'origine — résolution
    // interne (GEN3IA_APP_ORIGIN, allowlist), jamais l'origine de la requête.
    expect(mockedFinalize).toHaveBeenCalledBefore(mockedPublish as never);
    expect(mockedFinalize).toHaveBeenCalledWith(RUN_ID, "paused");
    expect(mockedPublish).toHaveBeenCalledWith(RUN_ID, { delaySeconds: NEXT_TICK_DELAY_SECONDS });
  });

  it("checkpoint présent → reprise : plan du checkpoint + sorties déjà payées", async () => {
    const checkpointPlan = {
      ...PLAN,
      steps: PLAN.steps.map((step, index) => ({ ...step, status: index === 0 ? ("completed" as const) : step.status })),
    };
    mockedLoadCheckpoint.mockResolvedValue({
      executionId: EXEC_ID, userId: "user-1", objective: "Étude de marché complète", status: "paused" as const,
      plan: checkpointPlan, observations: [], evaluations: [], outputs: { s1: "Recherche déjà faite" },
      iteration: 2, totalRetries: 1, maxTotalRetries: 15,
      billing: { currency: "XAF", totalChargeMinor: 6, totalProviderCostEur: 0.02, llmInputTokens: 300, llmOutputTokens: 150 },
      startedAt: new Date().toISOString(),
    } as never);
    mockRun.mockResolvedValue(pausedState());
    await POST(tickRequest(JSON.stringify({ runId: RUN_ID })));
    const options = mockConstructorCalls[0];
    expect(options.plan).toEqual(checkpointPlan);
    expect(options.initialOutputs).toEqual({ s1: "Recherche déjà faite" });
  });

  it("mission complétée → finalisation terminale, AUCUN ré-enfilement", async () => {
    mockRun.mockResolvedValue({ ...pausedState(), status: "completed" });
    const response = await POST(tickRequest(JSON.stringify({ runId: RUN_ID })));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ ok: true, status: "completed" });
    expect(mockedPublish).not.toHaveBeenCalled();
    expect(mockedFinalize).toHaveBeenCalledWith(RUN_ID, "completed", { error: undefined });
  });

  it("pause UTILISATEUR → terminaison dans la file (reprise jamais forcée)", async () => {
    mockedUserPause.mockResolvedValue(true);
    mockRun.mockResolvedValue(pausedState());
    const response = await POST(tickRequest(JSON.stringify({ runId: RUN_ID })));
    expect(mockedPublish).not.toHaveBeenCalled();
    expect(mockedFinalize).toHaveBeenCalledWith(RUN_ID, "paused", { error: undefined });
    expect((await response.json()).reenqueued).toBeUndefined();
  });

  it("échec MÉTIER (étape failed) → mission failed, 2xx sans redélivrance (anti double facturation)", async () => {
    mockRun.mockRejectedValue(new Error("Step timeout after 55000ms"));
    const response = await POST(tickRequest(JSON.stringify({ runId: RUN_ID })));
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("failed");
    expect(mockedFinalize).toHaveBeenCalledWith(RUN_ID, "failed", { error: "Step timeout after 55000ms" });
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it("échec INFRASTRUCTURE → 5xx pour redélivrance QStash (le bail expire, le claim reprend)", async () => {
    mockedProgress.mockRejectedValue(new Error("Firestore unavailable"));
    const response = await POST(tickRequest(JSON.stringify({ runId: RUN_ID })));
    expect(response.status).toBe(500);
    expect(mockedFinalize).not.toHaveBeenCalledWith(RUN_ID, "failed", expect.anything());
  });

  it("échec de publish pendant le ré-enfilement → 5xx (redélivrance rejouera le ré-enfilement)", async () => {
    mockedPublish.mockRejectedValue(new Error("QStash 502"));
    const response = await POST(tickRequest(JSON.stringify({ runId: RUN_ID })));
    expect(response.status).toBe(500);
    // La finalisation (bail relâché) a DÉJÀ eu lieu : la redélivrance pourra claim.
    expect(mockedFinalize).toHaveBeenCalledWith(RUN_ID, "paused");
  });

  it("ré-enfilement SANS origine dérivée de la requête (origine canonique interne)", async () => {
    // La route ne calcule plus AUCUNE origine : même envoyée depuis un hôte
    // arbitraire (gen3ia.local), la destination n'en dépend PLUS — le publish
    // reçoit uniquement (runId, options) et résout GEN3IA_APP_ORIGIN côté
    // serveur (allowlist, fix CodeQL request-forgery).
    mockRun.mockResolvedValue(pausedState());
    await POST(tickRequest(JSON.stringify({ runId: RUN_ID })));
    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const args = mockedPublish.mock.calls[0];
    expect(args?.[0]).toBe(RUN_ID);
    expect(args?.[1]).toMatchObject({ delaySeconds: NEXT_TICK_DELAY_SECONDS });
    expect(args).toHaveLength(2);
  });
});

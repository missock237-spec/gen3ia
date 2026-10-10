import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Route d'entrée /api/agents/run — deux modes (recommandation A) :
 * async (file QStash, 202 + runId + URLs de suivi) et sync (fallback,
 * compatibilité intégrations). La mission async ne doit JAMAIS retomber
 * silencieusement en sync quand l'appelant l'a demandée explicitement
 * (mode:"async") : un démarrage synchrone serait coupé par la plateforme
 * sans que le client le sache.
 */

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/queue/tick-queue", () => ({
  tickQueueConfigured: vi.fn(),
  enqueueMissionTick: vi.fn(),
}));
vi.mock("@/lib/queue/mission-queue", () => ({
  createQueuedMission: vi.fn(),
  markMissionEnqueueFailed: vi.fn(),
}));
vi.mock("@/lib/agents/runtime/runner", () => ({
  AgentRuntime: vi.fn(function AgentRuntimeMock(options: Record<string, unknown>) {
    mockConstructorCalls.push(options);
    return { run: mockRun };
  }),
}));
const mockGetDeveloperProject = vi.fn();
vi.mock("@/lib/developer/projects", () => ({
  getDeveloperProject: (...args: unknown[]) => mockGetDeveloperProject(...args),
}));
vi.mock("@/lib/observability/logger", () => {
  const makeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  return {
    executionLogger: () => ({ ...makeLog(), child: vi.fn(() => makeLog()) }),
    safeError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
  };
});

import { requireUser } from "@/lib/security/authenticated-request";
import { tickQueueConfigured, enqueueMissionTick } from "@/lib/queue/tick-queue";
import { createQueuedMission, markMissionEnqueueFailed } from "@/lib/queue/mission-queue";
import { AgentRuntime } from "@/lib/agents/runtime/runner";
import { POST } from "./route";

const mockedRequireUser = vi.mocked(requireUser);
const mockedConfigured = vi.mocked(tickQueueConfigured);
const mockedPublish = vi.mocked(enqueueMissionTick);
const mockedCreate = vi.mocked(createQueuedMission);
const mockedEnqueueFailed = vi.mocked(markMissionEnqueueFailed);
const mockRun = vi.fn();
const mockConstructorCalls: Array<Record<string, unknown>> = [];

const EXEC_ID = "aa11bb22-cc33-dd44-ee55-ff6677889900";

function postRequest(body: unknown, origin = "https://gen3ia.local"): NextRequest {
  return new NextRequest(`${origin}/api/agents/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SUCCESS_STATE = {
  status: "completed" as const,
  executionId: EXEC_ID,
  outputs: { step_1: "Livrable" },
  observations: [{ stepId: "step_1", success: true, latencyMs: 120, timestamp: new Date().toISOString() }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockConstructorCalls.length = 0;
  mockedRequireUser.mockResolvedValue({ uid: "user-1" } as never);
  mockedConfigured.mockReturnValue(true);
  mockedPublish.mockResolvedValue({ ok: true, mode: "r2-queue", messageId: "msg-1" });
  mockedCreate.mockResolvedValue(undefined);
  mockRun.mockResolvedValue({ ...SUCCESS_STATE });
});

describe("POST /api/agents/run — mode async (file configurée)", () => {
  it("202 immédiat : mission enregistrée, tick publié, runId + URLs de suivi", async () => {
    const response = await POST(postRequest({ objective: "Étude de marché sur le secteur minier" }));
    expect(response.status).toBe(202);
    const payload = await response.json();
    expect(payload.async).toBe(true);
    expect(payload.status).toBe("queued");
    expect(payload.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.statusUrl).toBe(`/api/agents/runs/${payload.runId}`);
    expect(payload.streamUrl).toBe(`/api/agents/runs/${payload.runId}/stream`);
    expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      objective: "Étude de marché sur le secteur minier",
    }));
    // Le plan enfilé contient l'exécution + l'objectif (exécutable par le receiver).
    const created = mockedCreate.mock.calls[0][0];
    expect(created.plan.executionId).toBe(payload.executionId);
    expect(created.plan.objective).toBe("Étude de marché sur le secteur minier");
    expect(created.plan.steps.length).toBeGreaterThan(0);
    // Enfilement initial : publication immédiate (sans délai — le ré-enfilement
    // des tranches suivantes est le seul à utiliser Upstash-Delay). Origine
    // canonique : plus aucune origine en paramètre (résolution interne serveur).
    expect(mockedPublish).toHaveBeenCalledWith(payload.runId);
    // AUCUNE exécution synchrone : la requête ne porte pas la mission.
    expect(AgentRuntime).not.toHaveBeenCalled();
  });

  it("échec d'enfilement en mode async explicite → 502 HONNÊTE + mission marquée failed (jamais de repli sync silencieux)", async () => {
    mockedPublish.mockRejectedValue(new Error("QStash 502"));
    const response = await POST(postRequest({ objective: "Mission longue critique", mode: "async" }));
    expect(response.status).toBe(502);
    expect(mockedEnqueueFailed).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
    expect((await response.json()).error).toContain("File d'attente indisponible");
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("mode auto + file non configurée → repli synchrone compatibilité (200, async:false)", async () => {
    mockedConfigured.mockReturnValue(false);
    const response = await POST(postRequest({ objective: "Simple résumé" }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.async).toBe(false);
    expect(payload.status).toBe("completed");
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalled();
  });

  it("mode sync explicite même avec file configurée → exécution dans la requête", async () => {
    const response = await POST(postRequest({ objective: "Résumé rapide", mode: "sync" }));
    expect(response.status).toBe(200);
    expect((await response.json()).async).toBe(false);
    expect(mockedPublish).not.toHaveBeenCalled();
    expect(AgentRuntime).toHaveBeenCalled();
  });

  it("échec d'enfilement en mode auto → repli synchrone assumé et journalisé", async () => {
    mockedPublish.mockRejectedValue(new Error("timeout"));
    const response = await POST(postRequest({ objective: "Objectif quelconque" }));
    expect(response.status).toBe(200);
    expect((await response.json()).async).toBe(false);
    expect(mockedEnqueueFailed).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalled();
  });

  it("le guard projet reste actif en async (403 avant tout enfilement)", async () => {
    mockGetDeveloperProject.mockResolvedValue(null);
    const response = await POST(postRequest({ objective: "Objectif", projectId: "p-1" }));
    expect(response.status).toBe(403);
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedPublish).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });
});

describe("POST /api/agents/run — validation", () => {
  it("400 sur objectif trop court ou corps invalide", async () => {
    for (const body of [{}, { objective: "ab" }, { objective: 42 }]) {
      const response = await POST(postRequest(body));
      expect(response.status).toBe(400);
    }
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("400 sur mode inconnu", async () => {
    const response = await POST(postRequest({ objective: "Objectif valide", mode: "parallel" }));
    expect(response.status).toBe(400);
  });
});

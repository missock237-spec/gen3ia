import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (fn: () => unknown) => {
      try { fn(); } catch { /* best-effort */ }
    },
  };
});

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/security/rate-limit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("@/lib/chat/repository", () => ({
  appendMessage: vi.fn(),
  createConversation: vi.fn(),
  getConversation: vi.fn(),
  listMessages: vi.fn(),
  updateConversation: vi.fn(),
}));
vi.mock("@/lib/agents/repository", () => ({ getAgentForUser: vi.fn() }));
vi.mock("@/lib/agents/personalized-plan", () => ({ policyForAgent: vi.fn(() => ({ allowedTools: ["web.search"] })) }));
vi.mock("@/lib/agents/chat-engine", () => ({
  answerAsAgent: vi.fn(),
  classifyRequest: vi.fn(),
  historyContextNote: vi.fn(() => "[Contexte de la conversation]"),
  unavailableCapabilityReply: vi.fn(() => "Capacité indisponible."),
  planAgentTask: vi.fn(),
}));
vi.mock("@/lib/agents/conversation-run", () => ({
  recordAgentRun: vi.fn(),
  reconcileAgentRun: vi.fn(),
}));
vi.mock("@/lib/agents/mission-delivery", () => ({
  deliverMissionToConversation: vi.fn(),
}));
vi.mock("@/lib/queue/mission-queue", () => ({
  createQueuedMission: vi.fn(),
}));
vi.mock("@/lib/queue/qstash", () => ({
  missionQueueConfigured: vi.fn(),
  publishMissionTick: vi.fn(),
}));
vi.mock("@/lib/queue/mission-continuation", () => ({
  enqueueMissionContinuation: vi.fn(),
}));
vi.mock("@/lib/memory/episodic", () => ({
  recallAgentContext: vi.fn(async () => undefined),
  recordExchange: vi.fn(async () => undefined),
  shouldSummarize: vi.fn(() => false),
  summarizeConversation: vi.fn(async () => undefined),
}));
vi.mock("@/lib/integrations/mcp/service", () => ({ describeServersForPrompt: vi.fn(async () => "") }));
vi.mock("@/lib/integrations/mention", () => ({
  describeConnectorsForPrompt: vi.fn(async () => ""),
  describeConnectedConnectorsForPrompt: vi.fn(async () => ({ toolkits: [] })),
}));
vi.mock("@/lib/agents/services/bridge", () => ({
  describeProjectServicesForPrompt: vi.fn(() => ""),
  PROJECT_SERVICE_TOOLS: [] as string[],
}));
vi.mock("@/lib/ai/image-generation", () => ({
  enhanceImagePrompt: vi.fn((prompt: string) => prompt),
  generateImageWithAgnes: vi.fn(),
  ImageGenerationError: class ImageGenerationError extends Error {},
  isImageGenerationEnabled: vi.fn(() => false),
  looksLikeImageRequest: vi.fn(() => false),
}));
vi.mock("@/lib/agents/action-approvals", () => ({
  createActionApproval: vi.fn(),
  listActionApprovals: vi.fn(async () => []),
}));
vi.mock("@/lib/agents/approval-policy", () => ({ selectApprovalRequiredSteps: vi.fn(async () => []) }));
vi.mock("@/lib/agents/runtime/unified-agent", () => ({ planUniversalAgent: vi.fn() }));
vi.mock("@/lib/integrations/custom-apis/repository", () => ({ listEnabledCustomApis: vi.fn(async () => []) }));
const mockRun = vi.fn();
vi.mock("@/lib/agents/runtime/runner", () => ({
  // Constructeur réel (pas flèche) : vitest 4 exige un constructeur pour `new`.
  AgentRuntime: vi.fn(function AgentRuntimeMock() {
    return { run: mockRun };
  }),
}));

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { appendMessage, getConversation, listMessages } from "@/lib/chat/repository";
import { getAgentForUser } from "@/lib/agents/repository";
import { classifyRequest, planAgentTask } from "@/lib/agents/chat-engine";
import { recordAgentRun } from "@/lib/agents/conversation-run";
import { deliverMissionToConversation } from "@/lib/agents/mission-delivery";
import { createQueuedMission } from "@/lib/queue/mission-queue";
import { missionQueueConfigured, publishMissionTick } from "@/lib/queue/qstash";
import { POST } from "./chat/route";

const mockedRequireUser = vi.mocked(requireUser);
const mockedEnforce = vi.mocked(enforceRateLimit);
const mockedGet = vi.mocked(getConversation);
const mockedList = vi.mocked(listMessages);
const mockedAppend = vi.mocked(appendMessage);
const mockedGetAgent = vi.mocked(getAgentForUser);
const mockedClassify = vi.mocked(classifyRequest);
const mockedPlanTask = vi.mocked(planAgentTask);
const mockedRecordRun = vi.mocked(recordAgentRun);
const mockedCreateQueued = vi.mocked(createQueuedMission);
const mockedConfigured = vi.mocked(missionQueueConfigured);
const mockedPublish = vi.mocked(publishMissionTick);

const AGENT = {
  id: "agent-1",
  name: "Rédacteur",
  description: "Agent de rédaction",
  type: "custom",
  typeLabel: "Rédaction",
  skills: [] as string[],
  status: "active" as const,
  memoryEnabled: false,
  tools: [] as string[],
  projectId: undefined,
  modelStrategy: "auto" as const,
};

const RUNTIME_PLAN = {
  executionId: "exec-1",
  objective: "objectif",
  steps: [{
    id: "s1", type: "llm" as const, name: "Rédiger", description: "Rédiger le livrable",
    dependencies: [], status: "pending" as const, input: {}, skillIds: [] as string[],
    maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false,
  }],
  maxConcurrency: 1,
  maxIterations: 1,
};

function postRequest(body: unknown): NextRequest {
  return new NextRequest("https://gen3ia.local/api/agent/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRequireUser.mockResolvedValue({ uid: "user-1" } as never);
  mockedEnforce.mockResolvedValue({ allowed: true, remaining: 59, retryAfterMs: 0, distributed: true } as never);
  mockedGetAgent.mockResolvedValue(AGENT as never);
  mockedGet.mockResolvedValue({ id: "conv-1", userId: "user-1", title: "Fil", messageCount: 2, status: "active" as const, agentId: "agent-1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as never);
  mockedList.mockResolvedValue([] as never);
  mockedAppend.mockResolvedValue({ id: "saved-1" } as never);
  mockedClassify.mockResolvedValue({ mode: "task", inScope: true, reason: "livrable" });
  mockedPlanTask.mockResolvedValue(RUNTIME_PLAN);
  mockedRecordRun.mockResolvedValue("run-1");
  mockedConfigured.mockReturnValue(true);
  mockedCreateQueued.mockResolvedValue(undefined as never);
  mockedPublish.mockResolvedValue(undefined as never);
  vi.mocked(deliverMissionToConversation).mockResolvedValue({ finalText: "Livrable final rédigé.", deliverables: [], messageId: undefined } as never);
  mockRun.mockResolvedValue({
    status: "completed",
    executionId: "exec-1",
    objective: "objectif",
    plan: RUNTIME_PLAN,
    observations: [],
    outputs: { s1: "Livrable final rédigé." },
    billing: { currency: "XAF", totalChargeMinor: 0, totalProviderCostEur: 0, llmInputTokens: 0, llmOutputTokens: 0 },
  });
});

/**
 * PERSISTANCE DE L'EXÉCUTION (exigence production) : « même si l'utilisateur
 * actualise le projet plusieurs fois, si une tâche a été lancée, la
 * conversation ou l'agent IA doit continuer sans s'arrêter ».
 *
 * Le mode task part SUR LA FILE QStash : l'exécution est 100 % serveur,
 * par tranches, et le run conversationnel est enregistré AVANT l'exécution
 * (le suivi live fonctionne dès les premières secondes). Le message final,
 * les livrables et la notification sont livrés par le tick final.
 */
describe("POST /api/agent/chat — mission en file (persistance après refresh)", () => {
  it("mode task + file configurée → 202 queued : mission enfilée avec conversationId + tick publié", async () => {
    const response = await POST(postRequest({ message: "Prépare le rapport", agentId: "agent-1", conversationId: "conv-1" }));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({ mode: "agent", status: "queued", executionId: "exec-1", conversationId: "conv-1" });
    expect(mockedCreateQueued).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      executionId: "exec-1",
      conversationId: "conv-1",
      plan: RUNTIME_PLAN,
    }));
    expect(mockedPublish).toHaveBeenCalledWith("https://gen3ia.local", expect.any(String));
    // AUCUN runtime lancé dans la requête : le travail est détaché de l'onglet.
    expect(mockedPlanTask).toHaveBeenCalledTimes(1);
  });

  it("le run conversationnel est enregistré AVANT l'exécution (suivi live)", async () => {
    await POST(postRequest({ message: "Prépare le rapport", agentId: "agent-1", conversationId: "conv-1" }));
    expect(mockedRecordRun).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv-1",
      plan: RUNTIME_PLAN,
      status: "running",
    }));
  });

  it("échec d'enfilement → repli synchrone DÉTACHÉ du client (jamais de signal requête)", async () => {
    mockedConfigured.mockReturnValue(false);
    const response = await POST(postRequest({ message: "Prépare le rapport", agentId: "agent-1", conversationId: "conv-1" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("completed");
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it("mode chat (question simple) : réponse directe, aucune mission en file", async () => {
    mockedClassify.mockResolvedValue({ mode: "chat", inScope: true, reason: "question" });
    const response = await POST(postRequest({ message: "Qui es-tu ?", agentId: "agent-1", conversationId: "conv-1" }));
    expect(response.status).toBe(200);
    expect((await response.json()).mode).toBe("chat");
    expect(mockedCreateQueued).not.toHaveBeenCalled();
  });
});

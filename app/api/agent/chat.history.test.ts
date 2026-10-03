import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

/**
 * Étape 1 du plan 20 — « l'historique des conversations d'agents n'est pas
 * mémorisé ». Ce fichier verrouille le contrat complet :
 *  1. un fil ouvert depuis le chat d'un agent est créé AVEC son agentId ;
 *  2. un fil legacy sans agentId est rattaché rétroactivement ;
 *  3. l'historique nourrissant le modèle est les messages RÉCENTS ;
 *  4. le classificateur reçoit l'historique (références implicites) ;
 *  5. le mode task planifie avec le contexte conversationnel ;
 *  6. la mission (run) est persistée sur le fil et liée au message final ;
 *  7. l'index Firestore composite du scoping par agent existe.
 */

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  // `after()` exige un scope de requête Next (indisponible sous vitest) :
  // exécution synchrone best-effort.
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
vi.mock("@/lib/agents/personalized-plan", () => ({
  policyForAgent: vi.fn(() => ({ allowedTools: ["web.search"] })),
}));
vi.mock("@/lib/agents/chat-engine", () => ({
  answerAsAgent: vi.fn(),
  classifyRequest: vi.fn(),
  historyContextNote: vi.fn(() => "[Contexte de la conversation — échanges précédents.]"),
  outOfScopeReply: vi.fn(() => "Hors périmètre."),
  planAgentTask: vi.fn(),
}));
vi.mock("@/lib/agents/conversation-run", () => ({
  recordAgentRun: vi.fn(),
  reconcileAgentRun: vi.fn(),
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
  // Implémentation par `function` (pas flèche) : vitest 4 exige un
  // constructeur réel pour `new AgentRuntime(...)`.
  AgentRuntime: vi.fn(function AgentRuntimeMock() {
    return { run: mockRun };
  }),
}));

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import {
  appendMessage,
  createConversation,
  getConversation,
  listMessages,
  updateConversation,
} from "@/lib/chat/repository";
import { getAgentForUser } from "@/lib/agents/repository";
import { answerAsAgent, classifyRequest, planAgentTask } from "@/lib/agents/chat-engine";
import { recordAgentRun, reconcileAgentRun } from "@/lib/agents/conversation-run";
import { POST } from "./chat/route";

const mockedRequireUser = vi.mocked(requireUser);
const mockedEnforce = vi.mocked(enforceRateLimit);
const mockedCreate = vi.mocked(createConversation);
const mockedGet = vi.mocked(getConversation);
const mockedList = vi.mocked(listMessages);
const mockedUpdate = vi.mocked(updateConversation);
const mockedAppend = vi.mocked(appendMessage);
const mockedGetAgent = vi.mocked(getAgentForUser);
const mockedClassify = vi.mocked(classifyRequest);
const mockedAnswer = vi.mocked(answerAsAgent);
const mockedPlanTask = vi.mocked(planAgentTask);
const mockedRecordRun = vi.mocked(recordAgentRun);
const mockedReconcile = vi.mocked(reconcileAgentRun);

const AGENT = {
  id: "agent-1",
  name: "Rédacteur",
  description: "Agent de rédaction",
  type: "custom",
  typeLabel: "Rédaction",
  skills: ["rédaction"],
  status: "active" as const,
  memoryEnabled: true,
  tools: [] as string[],
  projectId: undefined,
  modelStrategy: "auto" as const,
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
  mockedList.mockResolvedValue([
    { id: "m1", conversationId: "conv-1", userId: "user-1", role: "user", content: "Bonjour, prépare un PDF.", createdAt: new Date().toISOString() },
    { id: "m2", conversationId: "conv-1", userId: "user-1", role: "assistant", content: "Le PDF est prêt.", createdAt: new Date().toISOString() },
  ] as never);
  mockedAppend.mockResolvedValue({ id: "saved-1" } as never);
  mockedClassify.mockResolvedValue({ mode: "chat", inScope: true, reason: "question" });
  mockedAnswer.mockResolvedValue("Voici ma réponse claire.");
  mockedRecordRun.mockResolvedValue("run-1");
  mockedCreate.mockResolvedValue({ id: "conv-new", userId: "user-1", title: "Test", messageCount: 0, status: "active" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), agentId: "agent-1" } as never);
  // Fil existant par défaut : déjà rattaché à l'agent (aucun backfill).
  mockedGet.mockResolvedValue({ id: "conv-1", userId: "user-1", title: "Fil", messageCount: 2, status: "active" as const, agentId: "agent-1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as never);
});

describe("POST /api/agent/chat — historique des conversations d'agent mémorisé", () => {
  it("crée le fil AVEC agentId : le rail « Historique des chats » de l'agent retrouve la conversation", async () => {
    const response = await POST(postRequest({ message: "Bonjour", agentId: "agent-1" }));
    expect(response.status).toBe(200);
    expect(mockedCreate).toHaveBeenCalledWith("user-1", "Bonjour", { agentId: "agent-1" });
    const body = await response.json();
    expect(body.conversationId).toBe("conv-new");
  });

  it("rattache rétroactivement un fil legacy créé sans agentId", async () => {
    mockedGet.mockResolvedValue({ id: "conv-legacy", userId: "user-1", title: "Ancien", messageCount: 4, status: "active" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as never);
    const response = await POST(postRequest({ message: "Reprise du fil", agentId: "agent-1", conversationId: "conv-legacy" }));
    expect(response.status).toBe(200);
    expect(mockedUpdate).toHaveBeenCalledWith("user-1", "conv-legacy", { agentId: "agent-1" });
  });

  it("ne rattache PAS un fil déjà scopé à l'agent (aucune écriture inutile)", async () => {
    mockedGet.mockResolvedValue({ id: "conv-1", userId: "user-1", title: "Fil", messageCount: 2, status: "active" as const, agentId: "agent-1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as never);
    await POST(postRequest({ message: "Suite", agentId: "agent-1", conversationId: "conv-1" }));
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("charge l'historique RÉCENT (ordre chronologique des plus récents) pour nourrir le modèle", async () => {
    await POST(postRequest({ message: "Suite", agentId: "agent-1", conversationId: "conv-1" }));
    expect(mockedList).toHaveBeenCalledWith("user-1", "conv-1", 30, { order: "recent" });
  });

  it("passe l'historique au classificateur : les références implicites sont résolues", async () => {
    await POST(postRequest({ message: "Et pour le même document ?", agentId: "agent-1", conversationId: "conv-1" }));
    const historyArg = mockedClassify.mock.calls[0]?.[2];
    expect(Array.isArray(historyArg)).toBe(true);
    expect(historyArg).toHaveLength(2);
    expect(historyArg?.[0]).toMatchObject({ role: "user", content: "Bonjour, prépare un PDF." });
  });

  it("mode chat : la réponse ET le message utilisateur sont persistés dans le fil", async () => {
    const response = await POST(postRequest({ message: "Qui es-tu ?", agentId: "agent-1", conversationId: "conv-1" }));
    const body = await response.json();
    expect(body.mode).toBe("chat");
    expect(body.reply).toBe("Voici ma réponse claire.");
    // message utilisateur persisté…
    expect(mockedAppend).toHaveBeenCalledWith(expect.objectContaining({ role: "user", content: "Qui es-tu ?" }));
    // …puis réponse assistant persistée.
    expect(mockedAppend).toHaveBeenCalledWith(expect.objectContaining({ role: "assistant", content: "Voici ma réponse claire." }));
  });

  it("pièces jointes MULTIPLES : la note de contexte liste chaque fichier pour l'agent", async () => {
    const response = await POST(postRequest({
      message: "Compare ces deux documents",
      agentId: "agent-1",
      conversationId: "conv-1",
      attachments: [
        { path: "uploads/doc-a.pdf", name: "doc-a.pdf" },
        { path: "uploads/doc-b.pdf", name: "doc-b.pdf" },
      ],
    }));
    const body = await response.json();
    expect(body.mode).toBe("chat");
    const note = mockedAnswer.mock.calls[0][3] as string;
    expect(note).toContain("2 fichiers");
    expect(note).toContain("doc-a.pdf");
    expect(note).toContain("doc-b.pdf");
    expect(note).toContain("file.read");
  });

  it("compat : l'ancienne pièce jointe unique (attachmentPath) reste acceptée", async () => {
    await POST(postRequest({
      message: "Analyse ce fichier",
      agentId: "agent-1",
      conversationId: "conv-1",
      attachmentPath: "uploads/seul.pdf",
      attachmentName: "seul.pdf",
    }));
    const note = mockedAnswer.mock.calls[0][3] as string;
    expect(note).toContain("seul.pdf");
    expect(note).toContain("file.read");
  });

  it("mode task : le planificateur reçoit le contexte conversationnel (note d'historique)", async () => {
    mockedClassify.mockResolvedValue({ mode: "task", inScope: true, reason: "livrable" });
    mockedPlanTask.mockResolvedValue({
      executionId: "exec-1",
      objective: "objectif",
      steps: [{
        id: "s1", type: "llm", name: "Rédiger", description: "Rédiger le livrable",
        dependencies: [], status: "completed", input: {}, skillIds: [], maxRetries: 2,
        timeoutMs: 120_000, sideEffect: false, requiresApproval: false,
      }],
      maxConcurrency: 1,
      maxIterations: 1,
    });
    mockRun.mockResolvedValue({
      status: "completed",
      executionId: "exec-1",
      objective: "objectif",
      plan: { executionId: "exec-1", objective: "objectif", steps: [], maxConcurrency: 1, maxIterations: 1 },
      observations: [],
      outputs: { s1: "Livrable final rédigé." },
      billing: { currency: "XAF", totalChargeMinor: 0, totalProviderCostEur: 0, llmInputTokens: 0, llmOutputTokens: 0 },
    });
    const response = await POST(postRequest({ message: "Prépare le rapport", agentId: "agent-1", conversationId: "conv-1" }));
    expect(response.status).toBe(200);
    const objective = mockedPlanTask.mock.calls[0]?.[2] ?? "";
    expect(objective).toContain("[Contexte de la conversation");
    expect(objective).toContain("Prépare le rapport");
  });

  it("mode task : la mission (run) est enregistrée sur le fil et liée au message final", async () => {
    mockedClassify.mockResolvedValue({ mode: "task", inScope: true, reason: "livrable" });
    const RUNTIME_PLAN = {
      executionId: "exec-1",
      objective: "objectif",
      steps: [{
        id: "s1", type: "llm" as const, name: "Rédiger", description: "Rédiger le livrable",
        dependencies: [], status: "completed" as const, input: {}, skillIds: [] as string[],
        maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false,
      }],
      maxConcurrency: 1,
      maxIterations: 1,
    };
    mockedPlanTask.mockResolvedValue(RUNTIME_PLAN);
    mockRun.mockResolvedValue({
      status: "completed",
      executionId: "exec-1",
      objective: "objectif",
      plan: RUNTIME_PLAN,
      observations: [],
      outputs: { s1: "Livrable final rédigé." },
      billing: { currency: "XAF", totalChargeMinor: 0, totalProviderCostEur: 0, llmInputTokens: 0, llmOutputTokens: 0 },
    });
    await POST(postRequest({ message: "Prépare le rapport", agentId: "agent-1", conversationId: "conv-1" }));
    // EXIGENCE PRODUCTION : le run est créé AVANT l'exécution (suivi live),
    // puis réconcilié à la livraison (statut final + texte final + livrables).
    expect(mockedRecordRun).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      conversationId: "conv-1",
      plan: expect.objectContaining({ executionId: "exec-1" }),
      status: "running",
    }));
    expect(mockedReconcile).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv-1",
      plan: expect.objectContaining({ executionId: "exec-1" }),
      status: "completed",
      finalText: "Livrable final rédigé.",
    }));
    expect(mockedAppend).toHaveBeenCalledWith(expect.objectContaining({
      role: "assistant",
      content: "Livrable final rédigé.",
      runId: "run-1",
    }));
  });

  it("un échec d'enregistrement du run ne bloque PAS la réponse de l'agent (fail-soft)", async () => {
    mockedClassify.mockResolvedValue({ mode: "task", inScope: true, reason: "livrable" });
    mockedPlanTask.mockResolvedValue({
      executionId: "exec-2",
      objective: "objectif",
      steps: [{
        id: "s1", type: "llm", name: "Rédiger", description: "Rédiger",
        dependencies: [], status: "completed", input: {}, skillIds: [], maxRetries: 2,
        timeoutMs: 120_000, sideEffect: false, requiresApproval: false,
      }],
      maxConcurrency: 1,
      maxIterations: 1,
    });
    mockRun.mockResolvedValue({
      status: "completed",
      executionId: "exec-2",
      objective: "objectif",
      plan: { executionId: "exec-2", objective: "objectif", steps: [], maxConcurrency: 1, maxIterations: 1 },
      observations: [],
      outputs: { s1: "ok" },
      billing: { currency: "XAF", totalChargeMinor: 0, totalProviderCostEur: 0, llmInputTokens: 0, llmOutputTokens: 0 },
    });
    mockedRecordRun.mockRejectedValue(new Error("firestore indisponible"));
    const response = await POST(postRequest({ message: "Prépare le rapport", agentId: "agent-1", conversationId: "conv-1" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("completed");
  });
});

describe("Index Firestore du scoping par agent", () => {
  it("l'index composite (userId, agentId, updatedAt DESC) est déclaré pour chatConversations", () => {
    const raw = readFileSync(path.join(process.cwd(), "firestore.indexes.json"), "utf8");
    const config = JSON.parse(raw) as { indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order: string }> }> };
    const scoped = config.indexes.find((index) =>
      index.collectionGroup === "chatConversations"
      && index.fields.some((f) => f.fieldPath === "agentId")
      && index.fields.some((f) => f.fieldPath === "userId")
      && index.fields.some((f) => f.fieldPath === "updatedAt" && f.order === "DESCENDING"),
    );
    expect(scoped).toBeTruthy();
  });
});

describe("POST /api/agent/chat — session absente/expirée", () => {
  it("renvoie 401 structuré (code AUTH_REQUIRED), pas un 400 trompeur", async () => {
    mockedRequireUser.mockRejectedValue(
      Object.assign(new Error("Authentification requise : jeton manquant ou session expirée."), { status: 401, code: "AUTH_REQUIRED" }),
    );
    const response = await POST(postRequest({ message: "probe", agentId: "agent-1" }));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.code).toBe("AUTH_REQUIRED");
  });
});

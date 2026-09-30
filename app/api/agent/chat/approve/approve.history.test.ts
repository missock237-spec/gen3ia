import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Étape 1 du plan 20 — cause racine RC5 : après une reprise post-approbation,
 * le résultat FINAL de la mission n'était jamais persisté dans le fil (seul
 * le refus l'était). La fin de mission disparaissait de l'historique.
 */

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/agents/action-approvals", () => ({
  approveAction: vi.fn(),
  claimActionExecution: vi.fn(),
  completeAction: vi.fn(),
  failAction: vi.fn(),
  listActionApprovals: vi.fn(),
  rejectAction: vi.fn(),
}));
vi.mock("@/lib/agents/runtime/checkpoint", () => ({ loadCheckpoint: vi.fn() }));
vi.mock("@/lib/chat/repository", () => ({ appendMessage: vi.fn() }));
vi.mock("@/lib/agents/conversation-run", () => ({
  reconcileAgentRun: vi.fn(),
  recordAgentRun: vi.fn(),
}));
const mockRun = vi.fn();
vi.mock("@/lib/agents/runtime/runner", () => ({
  // Implémentation par `function` (pas flèche) : vitest 4 exige un
  // constructeur réel pour `new AgentRuntime(...)`.
  AgentRuntime: vi.fn(function AgentRuntimeMock() {
    return { run: mockRun };
  }),
}));

import { requireUser } from "@/lib/security/authenticated-request";
import { appendMessage } from "@/lib/chat/repository";
import { reconcileAgentRun } from "@/lib/agents/conversation-run";
import {
  approveAction,
  claimActionExecution,
  completeAction,
  failAction,
  listActionApprovals,
} from "@/lib/agents/action-approvals";
import { loadCheckpoint } from "@/lib/agents/runtime/checkpoint";
import { POST } from "./route";

const mockedRequireUser = vi.mocked(requireUser);
const mockedApprove = vi.mocked(approveAction);
const mockedClaim = vi.mocked(claimActionExecution);
const mockedListApprovals = vi.mocked(listActionApprovals);
const mockedLoadCheckpoint = vi.mocked(loadCheckpoint);
const mockedAppend = vi.mocked(appendMessage);
const mockedReconcile = vi.mocked(reconcileAgentRun);

const PLAN = {
  executionId: "exec-1",
  objective: "Publier l'article",
  steps: [{
    id: "s1", type: "llm" as const, name: "Rédiger", description: "Rédiger l'article final",
    dependencies: [], status: "completed" as const, input: {}, skillIds: [] as string[],
    maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false,
  }],
  maxConcurrency: 1,
  maxIterations: 1,
};

function postRequest(body: unknown): NextRequest {
  return new NextRequest("https://gen3ia.local/api/agent/chat/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRequireUser.mockResolvedValue({ uid: "user-1" } as never);
  mockedApprove.mockResolvedValue({ id: "appr-1", executionId: "exec-1", status: "approved", arguments: { __stepId: "s1" }, toolSlug: "web.search", reason: "" } as never);
  mockedListApprovals.mockResolvedValue([{
    id: "appr-1", executionId: "exec-1", ownerId: "user-1", role: "admin" as const,
    toolSlug: "web.search", arguments: { __stepId: "s1" }, reason: "",
    status: "approved" as const, createdAt: new Date().toISOString(),
  }] as never);
  mockedClaim.mockResolvedValue(undefined as never);
  vi.mocked(completeAction).mockResolvedValue(undefined as never);
  vi.mocked(failAction).mockResolvedValue(undefined as never);
  mockedLoadCheckpoint.mockResolvedValue({
    executionId: "exec-1",
    userId: "user-1",
    objective: "Publier l'article",
    conversationId: "conv-1",
    status: "pending" as const,
    plan: PLAN,
    observations: [],
    evaluations: [],
    outputs: {},
    iteration: 0,
    totalRetries: 0,
    maxTotalRetries: 15,
    billing: { currency: "XAF", totalChargeMinor: 0, totalProviderCostEur: 0, llmInputTokens: 0, llmOutputTokens: 0 },
  } as never);
  mockRun.mockResolvedValue({
    status: "completed",
    executionId: "exec-1",
    objective: "Publier l'article",
    plan: PLAN,
    observations: [],
    outputs: { s1: "Article final livré." },
    billing: { currency: "XAF", totalChargeMinor: 0, totalProviderCostEur: 0, llmInputTokens: 0, llmOutputTokens: 0 },
  });
  mockedAppend.mockResolvedValue({ id: "saved-1" } as never);
  mockedReconcile.mockResolvedValue(undefined as never);
});

describe("POST /api/agent/chat/approve — le résultat final rejoint l'historique", () => {
  it("persiste le résultat FINAL dans le fil après exécution réussie", async () => {
    const response = await POST(postRequest({ approvalId: "appr-1", action: "approve" }));
    expect(response.status).toBe(200);
    expect(mockedAppend).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv-1",
      role: "assistant",
      content: "Article final livré.",
    }));
  });

  it("persiste un message d'échec explicite quand l'exécution reprise échoue (jamais de faux « livré »)", async () => {
    mockRun.mockResolvedValue({
      status: "failed",
      executionId: "exec-1",
      objective: "Publier l'article",
      plan: PLAN,
      observations: [],
      outputs: {},
      error: "outil indisponible",
      billing: { currency: "XAF", totalChargeMinor: 0, totalProviderCostEur: 0, llmInputTokens: 0, llmOutputTokens: 0 },
    });
    await POST(postRequest({ approvalId: "appr-1", action: "approve" }));
    expect(mockedAppend).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv-1",
      role: "assistant",
      content: expect.stringContaining("interrompue"),
    }));
  });

  it("réconcilie le run lié à la conversation (statut final + timeline)", async () => {
    await POST(postRequest({ approvalId: "appr-1", action: "approve" }));
    expect(mockedReconcile).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      conversationId: "conv-1",
      plan: PLAN,
      status: "completed",
      finalText: "Article final livré.",
    }));
  });

  it("réclame l'action approuvée avant exécution (coupe-circuit anti double-exécution conservé)", async () => {
    await POST(postRequest({ approvalId: "appr-1", action: "approve" }));
    expect(mockedClaim).toHaveBeenCalledWith("user-1", "appr-1");
  });
});

describe("POST /api/agent/chat/approve — session absente/expirée", () => {
  it("renvoie 401 structuré (jamais un 500 opaque)", async () => {
    mockedRequireUser.mockRejectedValue(
      Object.assign(new Error("Authentification requise : jeton manquant ou session expirée."), { status: 401, code: "AUTH_REQUIRED" }),
    );
    const response = await POST(postRequest({ approvalId: "appr-1", action: "approve" }));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.code).toBe("AUTH_REQUIRED");
  });
});

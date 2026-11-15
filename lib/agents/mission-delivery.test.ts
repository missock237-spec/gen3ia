import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/chat/repository", () => ({
  appendMessage: vi.fn(),
}));
vi.mock("@/lib/agents/conversation-run", () => ({
  reconcileAgentRun: vi.fn(),
}));
vi.mock("@/lib/notifications/repository", () => ({
  createNotification: vi.fn(),
}));

import { appendMessage } from "@/lib/chat/repository";
import { reconcileAgentRun } from "@/lib/agents/conversation-run";
import { createNotification } from "@/lib/notifications/repository";
import { deliverMissionToConversation } from "./mission-delivery";

const mockedAppend = vi.mocked(appendMessage);
const mockedReconcile = vi.mocked(reconcileAgentRun);
const mockedNotify = vi.mocked(createNotification);

function state(overrides: Record<string, unknown> = {}) {
  return {
    plan: {
      executionId: "exec-1",
      objective: "Rédiger le rapport trimestriel",
      steps: [{
        id: "a1", type: "tool" as const, name: "Livrable", description: "Rapport final",
        dependencies: [] as string[], status: "completed" as const, input: {}, skillIds: [] as string[],
        maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false,
        toolName: "artifact.create",
      }],
      maxConcurrency: 1,
      maxIterations: 5,
    },
    outputs: { a1: { success: true, artifactId: "art-1", filename: "rapport.pdf", format: "pdf", sizeBytes: 4096, storageKey: "k" } },
    status: "completed" as const,
    error: undefined,
    observations: [],
    billing: { currency: "XAF", totalChargeMinor: 5, totalProviderCostEur: 0.01, llmInputTokens: 10, llmOutputTokens: 20 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedAppend.mockResolvedValue({ id: "saved-1" } as never);
  mockedReconcile.mockResolvedValue(undefined as never);
  mockedNotify.mockResolvedValue(null as never);
});

/**
 * LIVRAISON DE MISSION À LA CONVERSATION (exigence production : l'agent ne
 * s'arrête que lorsqu'il a terminé ET LIVRÉ le résultat à l'utilisateur).
 */
describe("deliverMissionToConversation", () => {
  it("persiste le message final avec le manifest des livrables réels", async () => {
    const result = await deliverMissionToConversation({
      userId: "user-1",
      conversationId: "conv-1",
      state: state(),
    });
    expect(mockedAppend).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv-1",
      role: "assistant",
      content: expect.stringContaining("rapport.pdf"),
    }));
    expect(mockedAppend.mock.calls[0]?.[0].content).toContain("Livrables remis (1)");
    expect(result.deliverables).toHaveLength(1);
    expect(result.finalText).toBeTruthy();
  });

  it("lie le run pré-existant au message final (timeline inline)", async () => {
    await deliverMissionToConversation({
      userId: "user-1",
      conversationId: "conv-1",
      state: state(),
      runId: "run-1",
    });
    expect(mockedAppend).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }));
  });

  it("message d'échec HONNÊTE : l'interruption est nommée, jamais de faux « livré »", async () => {
    await deliverMissionToConversation({
      userId: "user-1",
      conversationId: "conv-1",
      state: state({ status: "failed", error: "outil indisponible" }),
    });
    const content = mockedAppend.mock.calls[0]?.[0].content as string;
    expect(content).toContain("interrompue");
    expect(content).toContain("outil indisponible");
  });

  it("notifie la livraison pour une mission en arrière-plan (file)", async () => {
    await deliverMissionToConversation({
      userId: "user-1",
      conversationId: "conv-1",
      state: state(),
      background: true,
    });
    expect(mockedNotify).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      type: "info",
      title: "Mission livrée",
      conversationId: "conv-1",
    }));
  });

  it("pas de notification en chemin synchrone (l'utilisateur est devant le chat)", async () => {
    await deliverMissionToConversation({ userId: "user-1", conversationId: "conv-1", state: state() });
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it("réconcilie le run conversationnel (statut final + timeline)", async () => {
    await deliverMissionToConversation({ userId: "user-1", conversationId: "conv-1", state: state() });
    expect(mockedReconcile).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv-1",
      status: "completed",
    }));
  });
});

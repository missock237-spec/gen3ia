import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/queue/mission-queue", () => ({
  createQueuedMission: vi.fn(),
  markMissionEnqueueFailed: vi.fn(),
}));
vi.mock("@/lib/queue/qstash", () => ({
  missionQueueConfigured: vi.fn(),
  publishMissionTick: vi.fn(),
}));

import { createQueuedMission, markMissionEnqueueFailed } from "@/lib/queue/mission-queue";
import { missionQueueConfigured, publishMissionTick } from "@/lib/queue/qstash";
import { enqueueMissionContinuation } from "./mission-continuation";

const mockedCreate = vi.mocked(createQueuedMission);
const mockedPublish = vi.mocked(publishMissionTick);
const mockedConfigured = vi.mocked(missionQueueConfigured);
const mockedMarkFailed = vi.mocked(markMissionEnqueueFailed);

const PLAN = {
  executionId: "exec-1",
  objective: "objectif",
  steps: [{
    id: "s1", type: "llm" as const, name: "Étape", description: "Étape",
    dependencies: [] as string[], status: "pending" as const, input: {}, skillIds: [] as string[],
    maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false,
  }],
  maxConcurrency: 1,
  maxIterations: 5,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedConfigured.mockReturnValue(true);
  mockedPublish.mockResolvedValue(undefined as never);
  mockedCreate.mockResolvedValue(undefined as never);
  mockedMarkFailed.mockResolvedValue(undefined as never);
});

/**
 * CONTINUATION DE MISSION DEPUIS UN CHEMIN SYNCHRONE (exigence production :
 * même si l'utilisateur actualise plusieurs fois, la tâche lancée continue
 * sans s'arrêter) — la suite d'une mission coupée par l'échéance de tranche
 * part sur la file QStash existante.
 */
describe("enqueueMissionContinuation", () => {
  it("enfile la suite : document de file avec conversationId + tick publié", async () => {
    const result = await enqueueMissionContinuation({
      userId: "user-1",
      executionId: "exec-1",
      objective: "objectif",
      plan: PLAN,
      conversationId: "conv-1",
      origin: "https://gen3ia.online",
    });
    expect(result).toMatchObject({ queued: true, runId: expect.any(String) });
    expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "exec-1",
      userId: "user-1",
      conversationId: "conv-1",
      plan: PLAN,
    }));
    expect(mockedPublish).toHaveBeenCalledWith("https://gen3ia.online", expect.any(String));
  });

  it("file non configurée → queued:false avec raison (reprise manuelle conservée)", async () => {
    mockedConfigured.mockReturnValue(false);
    const result = await enqueueMissionContinuation({
      userId: "user-1",
      executionId: "exec-1",
      objective: "objectif",
      plan: PLAN,
      origin: "https://gen3ia.online",
    });
    expect(result.queued).toBe(false);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("échec de publish → queued:false et mission marquée honnêtement en échec", async () => {
    mockedPublish.mockRejectedValue(new Error("QStash 502"));
    const result = await enqueueMissionContinuation({
      userId: "user-1",
      executionId: "exec-1",
      objective: "objectif",
      plan: PLAN,
      origin: "https://gen3ia.online",
    });
    expect(result.queued).toBe(false);
    expect(mockedMarkFailed).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
  });
});

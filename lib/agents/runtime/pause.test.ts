import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests du contrôle de pause des exécutions d'agents :
 *  - demande de pause (écriture idempotente du contrôle) ;
 *  - levée de pause (suppression + autorisation propriétaire) ;
 *  - tolérance aux pannes Firestore (isPause → false, jamais d'exception) ;
 *  - PauseRequestedError typé pour le branchement du runner.
 */

const docMock = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: docMock,
    })),
  },
}));

const controlDoc = {
  set: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  docMock.mockReturnValue(controlDoc);
});

import {
  PauseRequestedError,
  clearExecutionPause,
  isExecutionPauseRequested,
  requestExecutionPause,
} from "./pause";

describe("contrôle de pause", () => {
  it("demande une pause avec userId + executionId (idempotent, merge)", async () => {
    controlDoc.set.mockResolvedValue(undefined);
    await requestExecutionPause({ userId: "u1", executionId: "exec-1", taskId: "t1", reason: "revue nécessaire" });
    expect(controlDoc.set).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        executionId: "exec-1",
        taskId: "t1",
        requested: true,
        reason: "revue nécessaire",
      }),
      { merge: true },
    );
  });

  it("isExecutionPauseRequested lit le contrôle", async () => {
    controlDoc.get.mockResolvedValue({ exists: true, get: () => true });
    await expect(isExecutionPauseRequested("exec-1")).resolves.toBe(true);
    controlDoc.get.mockResolvedValue({ exists: false, get: () => false });
    await expect(isExecutionPauseRequested("exec-2")).resolves.toBe(false);
  });

  it("ne bloque JAMAIS l'exécution si Firestore est en panne (false, pas d'exception)", async () => {
    controlDoc.get.mockRejectedValue(new Error("firestore down"));
    await expect(isExecutionPauseRequested("exec-1")).resolves.toBe(false);
  });

  it("lève la pause (propriétaire)", async () => {
    controlDoc.get.mockResolvedValue({ exists: true, get: (field: string) => (field === "userId" ? "u1" : undefined) });
    controlDoc.delete.mockResolvedValue(undefined);
    await expect(clearExecutionPause("u1", "exec-1")).resolves.toBeUndefined();
    expect(controlDoc.delete).toHaveBeenCalledTimes(1);
  });

  it("refuse la levée par un non-propriétaire", async () => {
    controlDoc.get.mockResolvedValue({ exists: true, get: (field: string) => (field === "userId" ? "u1" : undefined) });
    await expect(clearExecutionPause("attacker", "exec-1")).rejects.toThrow("Pause control not found.");
  });

  it("levée sur contrôle inexistant : no-op", async () => {
    controlDoc.get.mockResolvedValue({ exists: false, get: () => undefined });
    await expect(clearExecutionPause("u1", "exec-9")).resolves.toBeUndefined();
    expect(controlDoc.delete).not.toHaveBeenCalled();
  });

  it("PauseRequestedError est typé par name (détection dans le runner)", () => {
    const error = new PauseRequestedError("exec-1");
    expect(error.name).toBe("PauseRequestedError");
    expect(error.message).toContain("exec-1");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests du contrôle d'ARRÊT DÉFINITIF des exécutions d'agents :
 *  - demande d'arrêt (mode "stop" écrit de façon idempotente) ;
 *  - lecture du contrôle d'arrêt (mode="stop" requis, pas une pause) ;
 *  - tolérance aux pannes Firestore (isStop → false, jamais d'exception) ;
 *  - StopRequestedError typé pour le branchement du runner (arrêt à tout
 *    moment demandé par l'utilisateur, distinct de la pause).
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
  StopRequestedError,
  isExecutionStopRequested,
  requestExecutionStop,
} from "./pause";

describe("contrôle d'arrêt définitif (stop à tout moment)", () => {
  it("demande l'arrêt en mode stop avec userId + executionId (merge idempotent)", async () => {
    controlDoc.set.mockResolvedValue(undefined);
    await requestExecutionStop({ userId: "u1", executionId: "exec-1", taskId: "t1", reason: "Utilisateur" });
    expect(controlDoc.set).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        executionId: "exec-1",
        taskId: "t1",
        mode: "stop",
        requested: true,
        reason: "Utilisateur",
      }),
      { merge: true },
    );
  });

  it("isExecutionStopRequested exige mode=stop + requested=true", async () => {
    controlDoc.get.mockResolvedValue({ exists: true, get: (field: string) => (field === "requested" ? true : field === "mode" ? "stop" : undefined) });
    await expect(isExecutionStopRequested("exec-1")).resolves.toBe(true);
    // requested sans mode="stop" = une pause, PAS un arrêt.
    controlDoc.get.mockResolvedValue({ exists: true, get: (field: string) => (field === "requested" ? true : field === "mode" ? "pause" : undefined) });
    await expect(isExecutionStopRequested("exec-2")).resolves.toBe(false);
    controlDoc.get.mockResolvedValue({ exists: false, get: () => undefined });
    await expect(isExecutionStopRequested("exec-3")).resolves.toBe(false);
  });

  it("ne bloque JAMAIS l'exécution si Firestore est en panne (false, pas d'exception)", async () => {
    controlDoc.get.mockRejectedValue(new Error("firestore down"));
    await expect(isExecutionStopRequested("exec-1")).resolves.toBe(false);
  });

  it("StopRequestedError est typé par name (détection dans le runner)", () => {
    const error = new StopRequestedError("exec-1");
    expect(error.name).toBe("StopRequestedError");
    expect(error.message).toContain("exec-1");
  });
});

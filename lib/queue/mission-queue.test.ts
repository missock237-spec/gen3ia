import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cycle de vie des missions en file (recommandation A) — le claim
 * TRANSACTIONNEL garantit un seul worker par tranche ; la progression et la
 * finalisation sont fail-soft (un incident Firestore de STATUT ne doit jamais
 * masquer un travail réel déjà accompli) ; la décision de ré-enfilement est
 * pure et testée sans base.
 */

const txUpdate = vi.fn();
const txGet = vi.fn();
const docSet = vi.fn();
const docGet = vi.fn();
const runTransaction = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  FieldValue: {
    increment: (n: number) => ({ __increment: n }),
    delete: () => ({ __delete: true }),
  },
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        set: docSet,
        get: docGet,
      })),
    })),
    runTransaction: (...args: unknown[]) => runTransaction(...args),
  },
}));

import {
  claimMissionTick,
  compactQueueStep,
  createQueuedMission,
  decideNextTick,
  finalizeMissionRun,
  markMissionEnqueueFailed,
  MISSION_LEASE_MS,
  NEXT_TICK_DELAY_SECONDS,
  persistMissionProgress,
} from "./mission-queue";

const PLAN = {
  executionId: "exec-1",
  objective: "Objectif de mission longue",
  steps: [
    { id: "s1", type: "llm" as const, name: "Recherche", description: "d", dependencies: [], status: "pending" as const, input: {}, skillIds: [] as string[], maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false },
    { id: "s2", type: "llm" as const, name: "Rédaction", description: "d", dependencies: ["s1"], status: "pending" as const, input: {}, skillIds: [] as string[], maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false },
  ],
  maxConcurrency: 1,
  maxIterations: 10,
};

function snapshotDoc(data: Record<string, unknown> | null) {
  return { exists: data !== null, data: () => data };
}

beforeEach(() => {
  txUpdate.mockReset();
  txGet.mockReset();
  docSet.mockReset();
  docGet.mockReset();
  runTransaction.mockReset();
});

describe("décision de ré-enfilement (pure)", () => {
  it("ré-enfile une pause D'ÉCHÉANCE avec étapes restantes (cœur du pattern par tranches)", () => {
    expect(decideNextTick({ status: "paused", pendingStepsRemaining: true, userPauseRequested: false })).toBe("reenqueue");
  });

  it("NE ré-enfile PAS une pause UTILISATEUR (reprise jamais forcée)", () => {
    expect(decideNextTick({ status: "paused", pendingStepsRemaining: true, userPauseRequested: true })).toBe("terminal");
  });

  it("NE ré-enfile PAS une pause sans étapes restantes", () => {
    expect(decideNextTick({ status: "paused", pendingStepsRemaining: false, userPauseRequested: false })).toBe("terminal");
  });

  it("termine sur les statuts finaux même avec du pending résiduel", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(decideNextTick({ status, pendingStepsRemaining: true, userPauseRequested: false })).toBe("terminal");
    }
  });
});

describe("claim transactionnel du tick", () => {
  it("claim et pose le bail DANS la transaction (un seul worker par tranche)", async () => {
    txGet.mockResolvedValue(snapshotDoc({
      runId: "run-1", userId: "u1", executionId: "exec-1", objective: "o",
      status: "queued", attempts: 0, plan: PLAN, timeline: [], pendingCount: 2,
      createdAtMs: 1, updatedAtMs: 2,
    }));
    runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ get: txGet, update: txUpdate }));

    const outcome = await claimMissionTick("run-1");
    expect(outcome.kind).toBe("claimed");
    if (outcome.kind !== "claimed") return;
    expect(outcome.record.attempts).toBe(1);
    expect(outcome.record.status).toBe("running");
    expect(outcome.record.leaseUntilMs).toBeGreaterThan(Date.now());
    expect(outcome.record.plan).toEqual(PLAN); // le plan complet voyage vers le receiver
    expect(txUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "running", leaseUntilMs: expect.any(Number), updatedAtMs: expect.any(Number) }),
    );
    // Le compteur de tentatives est incrémenté via la sentinelle réelle
    // FieldValue.increment (paquet Firestore non mocké) : on vérifie sa
    // présence, pas sa représentation interne.
    const updatePayload = txUpdate.mock.calls[0][1] as Record<string, unknown>;
    expect(updatePayload.attempts).toBeDefined();
    const lease = txUpdate.mock.calls[0][1].leaseUntilMs as number;
    expect(lease - Date.now()).toBeLessThanOrEqual(MISSION_LEASE_MS);
  });

  it("no-op quand le bail est encore actif (redélivrance pendant un tick vivant)", async () => {
    txGet.mockResolvedValue(snapshotDoc({
      runId: "run-1", userId: "u1", executionId: "e", objective: "o",
      status: "running", attempts: 1, leaseUntilMs: Date.now() + 60_000,
      timeline: [], pendingCount: 1, createdAtMs: 1, updatedAtMs: 2,
    }));
    runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ get: txGet, update: txUpdate }));
    const outcome = await claimMissionTick("run-1");
    expect(outcome).toEqual({ kind: "lease-held" });
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it("reprend après expiration du bail (kill plateforme → la mission ne meurt pas)", async () => {
    txGet.mockResolvedValue(snapshotDoc({
      runId: "run-1", userId: "u1", executionId: "e", objective: "o",
      status: "running", attempts: 3, leaseUntilMs: Date.now() - 1_000,
      timeline: [], pendingCount: 1, createdAtMs: 1, updatedAtMs: 2,
    }));
    runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ get: txGet, update: txUpdate }));
    const outcome = await claimMissionTick("run-1");
    expect(outcome.kind).toBe("claimed");
    expect(txUpdate).toHaveBeenCalled();
  });

  it("no-op sur un statut terminal (redélivrance après complétion)", async () => {
    for (const status of ["completed", "failed", "cancelled"]) {
      txGet.mockResolvedValue(snapshotDoc({
        runId: "run-1", userId: "u1", executionId: "e", objective: "o",
        status, attempts: 2, timeline: [], pendingCount: 0, createdAtMs: 1, updatedAtMs: 2,
      }));
      runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ get: txGet, update: txUpdate }));
      const outcome = await claimMissionTick("run-1");
      expect(outcome).toEqual({ kind: "terminal", status });
    }
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it("missing sur document absent (mission jamais créée)", async () => {
    txGet.mockResolvedValue(snapshotDoc(null));
    runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ get: txGet, update: txUpdate }));
    expect(await claimMissionTick("run-x")).toEqual({ kind: "missing" });
  });
});

describe("écritures de la file", () => {
  it("createQueuedMission pose le statut queued + plan complet + compteur de pending", async () => {
    docSet.mockResolvedValue(undefined);
    await createQueuedMission({ runId: "run-9", executionId: "exec-9", userId: "u1", objective: "o", plan: PLAN });
    const written = docSet.mock.calls[0][0];
    expect(written.status).toBe("queued");
    expect(written.plan).toEqual(PLAN);
    expect(written.pendingCount).toBe(2);
    expect(written.timeline).toHaveLength(2);
    expect(written.timeline[0]).toMatchObject({ id: "s1", name: "Recherche", status: "pending" });
  });

  it("persistMissionProgress est fail-soft (incident Firestore jamais propagé)", async () => {
    docSet.mockRejectedValue(new Error("Firestore down"));
    await expect(
      persistMissionProgress("run-9", [
        { id: "s1", name: "Recherche", type: "llm", status: "completed", output: "Sortie texte riche" },
        { id: "s2", name: "Rédaction", type: "llm", status: "pending" },
      ]),
    ).resolves.toBeUndefined();
  });

  it("persistMissionProgress compte les étapes restantes et borne les aperçus", async () => {
    docSet.mockResolvedValue(undefined);
    await persistMissionProgress("run-9", [
      { id: "s1", name: "Recherche", type: "llm", status: "completed", output: "x".repeat(2_000) },
      { id: "s2", name: "Rédaction", type: "llm", status: "pending" },
    ]);
    const [mergePayload, options] = docSet.mock.calls[0];
    expect(mergePayload.pendingCount).toBe(1);
    const preview = mergePayload.timeline[0].outputPreview as string;
    expect(preview.length).toBeLessThanOrEqual(801); // 800 + ellipse
    expect(preview.endsWith("…")).toBe(true);
    expect(options).toEqual({ merge: true });
  });

  it("finalizeMissionRun fige le statut terminal et relâche le bail (fail-soft)", async () => {
    docSet.mockResolvedValue(undefined);
    await finalizeMissionRun("run-9", "completed");
    const payload = docSet.mock.calls[0][0];
    expect(payload.status).toBe("completed");
    expect(payload.completedAtMs).toBeGreaterThan(0);
    await finalizeMissionRun("run-9", "failed", { error: "boom".repeat(1_000) });
    const failedPayload = docSet.mock.calls[1][0];
    expect(failedPayload.status).toBe("failed");
    expect(String(failedPayload.lastError).length).toBeLessThanOrEqual(2_000);
    docSet.mockRejectedValue(new Error("down"));
    await expect(finalizeMissionRun("run-9", "cancelled")).resolves.toBeUndefined();
  });

  it("markMissionEnqueueFailed qualifie l'échec d'enfilement initial (fail-soft)", async () => {
    docSet.mockResolvedValue(undefined);
    await markMissionEnqueueFailed("run-9", new Error("QStash 502"));
    const payload = docSet.mock.calls[0][0];
    expect(payload.status).toBe("failed");
    expect(payload.lastError).toContain("File d'attente indisponible");
    expect(payload.lastError).toContain("QStash 502");
    docSet.mockRejectedValue(new Error("down too"));
    await expect(markMissionEnqueueFailed("run-9", new Error("x"))).resolves.toBeUndefined();
  });
});

describe("aperçus d'étapes", () => {
  it("compactQueueStep borne et structure la timeline (jamais de payload brut)", () => {
    const step = compactQueueStep({ id: "s1", name: "Étape très longue ".repeat(30), type: "llm", status: "completed", output: { nested: "y".repeat(2_000) } });
    expect(step.name.length).toBeLessThanOrEqual(200);
    expect((step.outputPreview as string).length).toBeLessThanOrEqual(801);
    expect(step.status).toBe("completed");
  });

  it("compactQueueStep survit à une sortie non sérialisable", () => {
    const step = compactQueueStep({ id: "s1", status: "completed", output: BigInt(42) });
    expect(step.outputPreview).toBeUndefined();
  });

  it("les constantes de file sont cohérentes avec la fenêtre serverless", () => {
    expect(MISSION_LEASE_MS).toBeGreaterThanOrEqual(60_000); // bail > fenêtre fonction
    expect(NEXT_TICK_DELAY_SECONDS).toBeGreaterThanOrEqual(1);
  });
});

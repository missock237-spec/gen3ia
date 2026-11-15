import { beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ */
/* Orchestrateur — honnêteté sans fournisseur, exécution simulée       */
/* clairement étiquetée, annulation.                                   */
/*                                                                    */
/* Le dépôt R2 et les providers sont mockés : on teste la LOGIQUE.      */
/* ------------------------------------------------------------------ */

vi.mock("@/lib/training/repository", () => ({
  getPlan: vi.fn(),
  listDatasets: vi.fn(),
  listActiveJobsForUser: vi.fn(),
  getJob: vi.fn(),
  saveJob: vi.fn(),
}));

import { getJob, listDatasets, listActiveJobsForUser, saveJob } from "@/lib/training/repository";
import { createJobFromPlan, dispatchJob, refreshJob, cancelJob } from "./orchestrator";
import { trainingJobSchema, trainingPlanSchema, type TrainingJob, type TrainingPlan } from "./types";

const mockedListDatasets = vi.mocked(listDatasets);
const mockedListActive = vi.mocked(listActiveJobsForUser);
const mockedSaveJob = vi.mocked(saveJob);

function makePlan(overrides: Partial<TrainingPlan> = {}): TrainingPlan {
  return trainingPlanSchema.parse({
    id: "plan-1",
    projectId: "proj-1",
    ownerId: "user-1",
    method: "lora",
    engineId: "text-lora",
    baseModel: "google/gemma-2-2b-it",
    baseModelKind: "catalog",
    parameters: { epochs: 2, learningRate: 0.0002, loraRank: 16, loraAlpha: 32, loraDropout: 0.05, batchSize: 4, maxSequenceLength: 1024, gradientAccumulation: 2 },
    resources: { vramGbEstimate: 10, providerClass: "worker-http" },
    generatedBy: "heuristic-fallback",
    status: "proposed",
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

function makeJob(overrides: Partial<TrainingJob> = {}): TrainingJob {
  return trainingJobSchema.parse({
    id: "job-1",
    projectId: "proj-1",
    planId: "plan-1",
    ownerId: "user-1",
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TRAINING_WORKER_URL;
  delete process.env.TRAINING_WORKER_TOKEN;
  delete process.env.TRAINING_ALLOW_MOCK;
  delete process.env.TRAINING_MOCK_STEP_MS;
  mockedListActive.mockResolvedValue([]);
  mockedSaveJob.mockResolvedValue(undefined);
});

describe("dispatchJob — sans fournisseur GPU (honnêteté)", () => {
  it("garde la tâche en file avec waitingReason explicite et un événement unique", async () => {
    process.env.TRAINING_ALLOW_MOCK = "false";
    const job = makeJob();
    const plan = makePlan();

    const first = await dispatchJob("user-1", job, plan);
    expect(first.status).toBe("queued");
    expect(first.waitingReason).toBe("no-gpu-provider");
    expect(first.events.some((e) => e.message.includes("Aucun fournisseur GPU"))).toBe(true);
    expect(first.simulated).toBe(false);

    // Second dispatch : pas de duplication d'événement.
    const second = await dispatchJob("user-1", first, plan);
    const warnings = second.events.filter((e) => e.message.includes("Aucun fournisseur GPU"));
    expect(warnings).toHaveLength(1);
  });
});

describe("dispatchJob — fournisseur mock (tests uniquement)", () => {
  it("confie la tâche et l'étiquette simulated", async () => {
    process.env.TRAINING_ALLOW_MOCK = "true";
    process.env.TRAINING_MOCK_STEP_MS = "1";
    process.env.NODE_ENV = "test";
    mockedListDatasets.mockResolvedValue([]);

    const job = makeJob();
    const plan = makePlan();
    const result = await dispatchJob("user-1", job, plan);

    expect(result.status).toBe("running");
    expect(result.simulated).toBe(true);
    expect(result.providerId).toBe("mock");
    expect(result.externalJobId).toBeTruthy();
    expect(result.events.some((e) => e.message.includes("[SIMULATION]"))).toBe(true);
    expect(result.waitingReason).toBeNull();
  });

  it("mène à completed après la durée simulée, avec artefacts vides (aucun poids produit)", async () => {
    process.env.TRAINING_ALLOW_MOCK = "true";
    process.env.TRAINING_MOCK_STEP_MS = "1";
    process.env.NODE_ENV = "test";
    mockedListDatasets.mockResolvedValue([]);

    const plan = makePlan();
    const running = await dispatchJob("user-1", makeJob(), plan);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const refreshed = await refreshJob("user-1", running);

    expect(["running", "completed"]).toContain(refreshed.status);
    // On pousse jusqu'au bout : la boucle de rafraîchissement termine le cycle.
    let final = refreshed;
    for (let i = 0; i < 10 && final.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      final = await refreshJob("user-1", final);
    }
    expect(final.status).toBe("completed");
    expect(final.simulated).toBe(true);
    expect(final.progressPercent).toBe(100);
    expect(final.artifacts).toHaveLength(0); // une simulation ne produit AUCUN poids
  });
});

describe("cancelJob", () => {
  it("annule une tâche en file et journalise", async () => {
    vi.mocked(getJob).mockResolvedValue(makeJob());
    const cancelled = await cancelJob("user-1", "proj-1", "job-1");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.events.some((e) => e.message.includes("annulée par l'utilisateur"))).toBe(true);
    expect(mockedSaveJob).toHaveBeenCalled();
  });

  it("refuse l'annulation d'une tâche terminée", async () => {
    vi.mocked(getJob).mockResolvedValue(makeJob({ status: "completed" }));
    await expect(cancelJob("user-1", "proj-1", "job-1")).rejects.toThrow(/ne peut pas être annulée/);
  });
});

describe("createJobFromPlan — garde-fous", () => {
  it("refuse un fine-tuning sans split d'entraînement", async () => {
    process.env.TRAINING_ALLOW_MOCK = "true";
    mockedListDatasets.mockResolvedValue([]);
    const result = await createJobFromPlan("user-1", makePlan());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("split d'entraînement");
  });

  it("refuse quand le quota de concurrence est atteint", async () => {
    process.env.TRAINING_ALLOW_MOCK = "true";
    mockedListDatasets.mockResolvedValue([
      {
        v: 1, id: "ds-1", projectId: "proj-1", ownerId: "user-1", name: "train.csv", format: "csv",
        storageKey: "users/user-1/training-files/proj-1/ds-1", sizeBytes: 100, sha256: "a".repeat(64),
        split: "train", status: "valid", stats: { rows: 100, columns: [], pairs: 100, duplicates: 0, emptyLines: 0, warnings: [] },
        findings: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    mockedListActive.mockResolvedValue([makeJob({ id: "autre-job", status: "running" })]);
    const result = await createJobFromPlan("user-1", makePlan());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("simultanée");
  });
});

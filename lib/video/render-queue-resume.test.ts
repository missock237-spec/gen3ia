import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { RenderJob } from "@/lib/video/types";

/**
 * Tests d'intégration de la reprise QUOTA-AWARE dans render-queue (Task 95-c).
 *
 * Patterns : adminDb factice avec runTransaction + état hoisted (comme
 * mission-queue.test.ts), couche résiliente mockée en vi.fn via le mock
 * PARTIEL de queue-resume (classifyTickError / resumePolicyFor restent
 * RÉELS), quotas simulés par code gRPC 8 (classifiés par le vrai quota-guard).
 */

// ---------------------------------------------------------------------------
// État hoisted — Firestore factice (docs + ops + requêtes + erreur tx)
// ---------------------------------------------------------------------------

const firestoreState = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  ops: [] as Array<{ kind: string; path: string; payload?: unknown; opts?: unknown }>,
  queryResults: [] as Array<Record<string, unknown>>,
  /** Quand défini, runTransaction lève cette erreur (quota, transitoire…). */
  txError: null as unknown,
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (id: string) => {
        const path = `${name}/${id}`;
        return {
          __path: path,
          create: async (payload: Record<string, unknown>) => {
            firestoreState.ops.push({ kind: "create", path, payload });
            firestoreState.docs.set(path, { ...payload });
            return {};
          },
          set: async (payload: Record<string, unknown>, opts?: { merge?: boolean }) => {
            firestoreState.ops.push({ kind: "set", path, payload, opts });
            const existing = firestoreState.docs.get(path);
            firestoreState.docs.set(path, opts?.merge === true ? { ...(existing ?? {}), ...payload } : { ...payload });
            return {};
          },
          get: async () => {
            firestoreState.ops.push({ kind: "get", path });
            const data = firestoreState.docs.get(path);
            return data ? { exists: true, data: () => data } : { exists: false, data: () => undefined };
          },
        };
      },
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => {
          firestoreState.ops.push({ kind: "where", path: `${name}?${field}==${String(value)}` });
          return {
            docs: firestoreState.queryResults.map((data, index) => ({ id: `q${index}`, data: () => data })),
            size: firestoreState.queryResults.length,
          };
        },
      }),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (firestoreState.txError) throw firestoreState.txError;
      return fn({
        get: async (ref: { __path: string }) => {
          const data = firestoreState.docs.get(ref.__path);
          return data ? { exists: true, data: () => data } : { exists: false, data: () => undefined };
        },
        update: (ref: { __path: string }, patch: Record<string, unknown>) => {
          firestoreState.ops.push({ kind: "tx-update", path: ref.__path, payload: patch });
          const existing = firestoreState.docs.get(ref.__path);
          firestoreState.docs.set(ref.__path, { ...(existing ?? {}), ...patch });
        },
      });
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock PARTIEL de queue-resume : la logique de reprise est mockée au niveau
// file (vi.fn), mais classifyTickError / resumePolicyFor restent RÉELS.
// ---------------------------------------------------------------------------

vi.mock("@/lib/video/queue-resume", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/video/queue-resume")>();
  return {
    ...actual,
    loadJobDoc: vi.fn(),
    saveJobDoc: vi.fn(),
    createJobDoc: vi.fn(),
    queryJobDocs: vi.fn(),
  };
});


// Task 106-fix — les checkpoints passent par writeCheckpointSet (firestore-fallback,
// même primitive que le claim) : la file de tests le mocke sur le MÊME vi.fn que
// saveJobDoc pour que les scénarios de reprise gardent leur contrat.
vi.mock("@/lib/db/firestore-resilient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/firestore-resilient")>();
  return {
    ...actual,
    writeCheckpointSet: (...args: Parameters<typeof import("@/lib/video/queue-resume")["saveJobDoc"]>) =>
      (queueResume.saveJobDoc as unknown as (...a: unknown[]) => Promise<void>)(...args),
    firestoreUsable: actual.firestoreUsable,
  };
});
vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/video/project-service", () => ({
  getOwnedProjectOrThrow: vi.fn(),
  logSystem: vi.fn(async () => undefined),
  setProjectStatus: vi.fn(async () => undefined),
}));

vi.mock("@/lib/video/asset-service", () => ({
  getAsset: vi.fn(async () => null),
  listAssets: vi.fn(async () => []),
}));

vi.mock("@/lib/video/credits", () => ({
  estimateRenderCost: vi.fn(() => ({ amountMinor: 1234 })),
  reserveRenderBudget: vi.fn(async () => undefined),
  settleRenderBudget: vi.fn(async () => 1100),
  releaseRenderBudget: vi.fn(async () => undefined),
  settleExportsBudget: vi.fn(async () => undefined),
}));

vi.mock("@/lib/video/render/engine", () => ({
  renderSegments: vi.fn(async () => []),
  assembleTransitions: vi.fn(),
  mixAudio: vi.fn(),
  finalizeMaster: vi.fn(),
  renderExportFormat: vi.fn(),
  uploadMaster: vi.fn(),
  cleanupJob: vi.fn(async () => undefined),
  createJobTmpDir: vi.fn(async () => "/tmp/gen3ia-render-test"),
}));

vi.mock("@/lib/video/storage", () => ({
  materializeForRender: vi.fn(),
  uploadVideoAsset: vi.fn(),
}));

vi.mock("@/lib/video/qc-service", () => ({
  analyzeRenderedMaster: vi.fn(),
  decideAutoFix: vi.fn(),
}));

vi.mock("@/lib/video/long-video-service", () => ({
  assembleRecursive: vi.fn(),
}));

vi.mock("@/lib/video/audio-engine", () => ({
  ensureAudioAssetsForProject: vi.fn(),
}));

vi.mock("@/lib/video/timeline-bootstrap", () => ({
  ensureProjectTimeline: vi.fn(),
}));

vi.mock("@/lib/notifications/repository", () => ({
  createNotification: vi.fn(async () => undefined),
}));

vi.mock("@/lib/queue/qstash", () => ({
  publishJsonDestination: vi.fn(async () => ({ ok: true, mode: "published", message: "" })),
  qstashConfig: vi.fn(() => null),
  verifyUpstashSignature: vi.fn(() => true),
}));

vi.mock("@/lib/video/progress-store", () => ({
  setJobProgress: vi.fn(async () => undefined),
  getJobProgress: vi.fn(async () => null),
}));

// ---------------------------------------------------------------------------
// Imports sujet + mocks pour assertions
// ---------------------------------------------------------------------------

import { JOBS_COLLECTION, RENDER_RETRY_BUDGET, advanceJob, startRenderJob, sweepStaleRenderJobs } from "./render-queue";
import * as queueResume from "@/lib/video/queue-resume";
import { releaseRenderBudget, reserveRenderBudget, settleRenderBudget } from "@/lib/video/credits";
import { renderSegments, uploadMaster } from "@/lib/video/render/engine";
import { createNotification } from "@/lib/notifications/repository";
import { getOwnedProjectOrThrow } from "@/lib/video/project-service";
import { listAssets } from "@/lib/video/asset-service";
import { setJobProgress } from "@/lib/video/progress-store";
import { publishJsonDestination } from "@/lib/queue/qstash";

function quotaError(message = "Quota exceeded for quota group 'default'."): Error {
  return Object.assign(new Error(message), { code: 8 });
}

/** Document job de base (étape segments, 2 segments en attente, bail posé). */
function baseJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job-1",
    projectId: "proj-1",
    userId: "user-1",
    status: "queued",
    stage: "segments",
    progress: 0.1,
    checkpoints: {
      downloadedAssetIds: [],
      completedSegments: [],
      transitionPass: 0,
      transitionsDone: false,
      audioDone: false,
      subtitlesDone: false,
      qcDone: false,
      exportsDone: [],
    },
    mode: "full",
    autoFixRounds: 0,
    attempts: 0,
    retryCount: 0,
    exports: [],
    billedMinor: 5000,
    tmpDir: "/tmp/gen3ia-render-test",
    plan: { segments: [{ index: 0 }, { index: 1 }], estimatedSec: 60, resolution: "720p" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function setDoc(job: Record<string, unknown>): void {
  firestoreState.docs.set(`${JOBS_COLLECTION}/${job.id as string}`, job);
}

beforeEach(() => {
  firestoreState.docs.clear();
  firestoreState.ops.length = 0;
  firestoreState.queryResults = [];
  firestoreState.txError = null;
  vi.clearAllMocks();
  // Origine canonique : publishVideoTick la résout AVANT d'appeler le mock
  // publishJsonDestination (l'ancien paramètre origin a été supprimé).
  process.env.GEN3IA_APP_ORIGIN = "https://gen3ia.online";
  delete process.env.GEN3IA_ALLOWED_ORIGINS;
  vi.mocked(queueResume.saveJobDoc).mockResolvedValue(undefined);
  vi.mocked(queueResume.loadJobDoc).mockResolvedValue(null as never);
  vi.mocked(queueResume.createJobDoc).mockResolvedValue(undefined);
  vi.mocked(queueResume.queryJobDocs).mockResolvedValue([] as never);
  setDoc(baseJob());
});

afterEach(() => {
  delete process.env.GEN3IA_APP_ORIGIN;
  delete process.env.GEN3IA_ALLOWED_ORIGINS;
});

// ---------------------------------------------------------------------------
// advanceJob — quota sur un checkpoint : reprise SANS consommer le budget
// ---------------------------------------------------------------------------

describe("advanceJob — erreur de quota sur un checkpoint", () => {
  it("re-file le job SANS consommer retryCount, avec quotaFailures et backoff", async () => {
    vi.mocked(renderSegments).mockImplementation(async (params) => {
      await params.onSegmentDone(0);
      return [];
    });
    // 1er appel saveJobDoc = checkpoint → QUOTA ; 2e = ré-file failJob → OK.
    vi.mocked(queueResume.saveJobDoc).mockRejectedValueOnce(quotaError()).mockResolvedValueOnce(undefined);

    const result = await advanceJob("job-1");

    const saveMock = vi.mocked(queueResume.saveJobDoc);
    expect(saveMock).toHaveBeenCalledTimes(2);
    const requeuePatch = saveMock.mock.calls[1][2] as Record<string, unknown>;
    expect(requeuePatch.status).toBe("queued");
    expect(requeuePatch.quotaFailures).toBe(1);
    expect("retryCount" in requeuePatch).toBe(false); // budget INTACT
    expect(requeuePatch.leaseOwner).toBeDefined(); // bail libéré
    const delayMs = Date.parse(requeuePatch.nextAttemptAt as string) - Date.parse(requeuePatch.updatedAt as string);
    expect(delayMs).toBeGreaterThanOrEqual(59_000); // backoff 30×2^1=60 s + gigue
    expect(delayMs).toBeLessThanOrEqual(66_000);
    expect(result.status).toBe("queued");
    expect(result.done).toBe(false);
    // JAMAIS d'échec définitif ni de notification pour un quota
    expect(releaseRenderBudget).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    // l'instantané de progression (process-local) reste alimenté côté catch
    expect(setJobProgress).toHaveBeenCalled();
  });

  it("le message stocké est actionnable et mentionne le quota", async () => {
    vi.mocked(renderSegments).mockImplementation(async (params) => {
      await params.onSegmentDone(0);
      return [];
    });
    vi.mocked(queueResume.saveJobDoc).mockRejectedValueOnce(quotaError()).mockResolvedValueOnce(undefined);

    await advanceJob("job-1");

    const requeuePatch = vi.mocked(queueResume.saveJobDoc).mock.calls[1][2] as Record<string, unknown>;
    expect(String(requeuePatch.errorMessage)).toMatch(/Quota Firestore épuisé/);
    expect(String(requeuePatch.errorMessage)).toMatch(/backoff/);
  });
});

// ---------------------------------------------------------------------------
// failJob — chemin legacy fatal PRÉSERVÉ (sans politique)
// ---------------------------------------------------------------------------

describe("failJob — chemin legacy inchangé", () => {
  it("sous le budget : re-file 15 s avec retryCount incrémenté", async () => {
    vi.mocked(renderSegments).mockRejectedValue(new Error("FFmpeg a échoué"));

    const result = await advanceJob("job-1");

    const saveMock = vi.mocked(queueResume.saveJobDoc);
    expect(saveMock).toHaveBeenCalledTimes(1);
    const patch = saveMock.mock.calls[0][2] as Record<string, unknown>;
    expect(patch.status).toBe("queued");
    expect(patch.retryCount).toBeDefined(); // sentinelle FieldValue.increment(1)
    expect(createNotification).not.toHaveBeenCalled();
    expect(releaseRenderBudget).not.toHaveBeenCalled();
    expect(result.status).toBe("queued");
    expect(result.done).toBe(false);
    // re-file QStash avec le délai legacy de 15 s
    expect(publishDelaySeconds()).toBe(15);
  });

  it("au budget (3) : échec définitif + libération réservation + notification", async () => {
    setDoc(baseJob({ retryCount: RENDER_RETRY_BUDGET }));
    vi.mocked(renderSegments).mockRejectedValue(new Error("FFmpeg a échoué"));

    const result = await advanceJob("job-1");

    const saveMock = vi.mocked(queueResume.saveJobDoc);
    const failedPatch = saveMock.mock.calls
      .map((call) => call[2] as Record<string, unknown>)
      .find((patch) => patch.status === "failed");
    expect(failedPatch).toMatchObject({ status: "failed", errorCode: "RENDER_FAILED" });
    expect(releaseRenderBudget).toHaveBeenCalledTimes(1);
    expect(releaseRenderBudget).toHaveBeenCalledWith("user-1", "job-1", 5000);
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("failed");
    expect(result.done).toBe(true);
  });
});

/** Délai QStash passé au dernier publish (helper de lisibilité). */
function publishDelaySeconds(): number {
  const last = vi.mocked(publishJsonDestination).mock.calls.at(-1);
  return (last?.[2] as { delaySeconds?: number } | undefined)?.delaySeconds ?? -1;
}

// ---------------------------------------------------------------------------
// claim — renonciation sous quota (Task 108 : plus de failover miroir)
// ---------------------------------------------------------------------------

describe("claimJobForTick — renonciation sous quota (Task 108)", () => {
  it("transaction en quota → erreur de quota PROPAGÉE (le tick est republié avec délai)", async () => {
    firestoreState.txError = quotaError();
    await expect(advanceJob("job-1")).rejects.toThrow(/Quota exceeded/);
    // aucune écriture de checkpoint au passage (rien n'a avancé)
    expect(queueResume.saveJobDoc).not.toHaveBeenCalled();
  });

  it("erreur transitoire de transaction : propagation inchangée", async () => {
    firestoreState.txError = Object.assign(new Error("Le service est actuellement indisponible."), { code: 14 });
    await expect(advanceJob("job-1")).rejects.toThrow(/indisponible/);
  });
});

// ---------------------------------------------------------------------------
// startRenderJob — compensation de la réservation wallet
// ---------------------------------------------------------------------------

describe("startRenderJob — compensation si la création du job échoue", () => {
  function stubProject(): void {
    vi.mocked(getOwnedProjectOrThrow).mockResolvedValue({
      id: "proj-1",
      userId: "user-1",
      resolution: "720p",
      targetDurationSec: 60,
      script: { scenes: [{ id: "s1" }], estimatedDurationSec: 60 },
    } as never);
    vi.mocked(listAssets).mockResolvedValue([{ id: "img-1", role: "scene:s1" }] as never);
  }

  it("création en QUOTA → réservation remboursée + message actionnable", async () => {
    stubProject();
    vi.mocked(queueResume.createJobDoc).mockRejectedValue(quotaError());

    await expect(
      startRenderJob({ userId: "user-1", projectId: "proj-1", derivedTargets: [] }),
    ).rejects.toThrow(/Quota Firestore épuisé au lancement du rendu/);

    expect(reserveRenderBudget).toHaveBeenCalledTimes(1);
    expect(releaseRenderBudget).toHaveBeenCalledTimes(1);
    expect(releaseRenderBudget).toHaveBeenCalledWith("user-1", expect.any(String), 1234);
  });

  it("erreur NON quota → remboursée aussi, mais message d'origine propagé", async () => {
    stubProject();
    vi.mocked(queueResume.createJobDoc).mockRejectedValue(new Error("donnée invalide"));

    await expect(
      startRenderJob({ userId: "user-1", projectId: "proj-1", derivedTargets: [] }),
    ).rejects.toThrow(/donnée invalide/);

    expect(releaseRenderBudget).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// stageFinalize — idempotence (double exécution après reprise quota)
// ---------------------------------------------------------------------------

describe("stageFinalize — idempotence", () => {
  it("master déjà livré → PAS de re-upload, PAS de re-facturation, état final écrit", async () => {
    setDoc(
      baseJob({
        status: "processing",
        stage: "finalize",
        leaseOwner: "job-1:ancien",
        leaseExpiresAt: 0,
        plan: { segments: [{ index: 0 }], estimatedSec: 60, resolution: "720p", masterR2Key: "renders/job-1/master.mp4" },
        output: { r2Key: "renders/job-1/master.mp4", sizeBytes: 1000, durationSec: 60, width: 1280, height: 720 },
      }),
    );

    const result = await advanceJob("job-1");

    expect(uploadMaster).not.toHaveBeenCalled();
    expect(settleRenderBudget).not.toHaveBeenCalled();
    const saveMock = vi.mocked(queueResume.saveJobDoc);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][2]).toMatchObject({ status: "completed", stage: "finalize", progress: 1 });
    expect(result.status).toBe("completed");
    expect(result.done).toBe(true);
  });

  it("premier passage (chemin nominal) : upload + settle + écriture finale complétée", async () => {
    // Garde cross-instance : le master doit exister sur l'instance du finalize.
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    await mkdir("/tmp/gen3ia-render-test", { recursive: true });
    await writeFile("/tmp/gen3ia-render-test/master.mp4", Buffer.from("master-test"));
    setDoc(baseJob({ status: "processing", stage: "finalize", leaseOwner: "job-1:ancien", leaseExpiresAt: 0 }));
    vi.mocked(uploadMaster).mockResolvedValue({
      r2Key: "renders/job-1/master.mp4",
      sizeBytes: 2048,
      durationSec: 61,
      width: 1280,
      height: 720,
    });
    vi.mocked(settleRenderBudget).mockResolvedValue(1150);

    try {
      const result = await advanceJob("job-1");

      expect(uploadMaster).toHaveBeenCalledTimes(1);
      expect(settleRenderBudget).toHaveBeenCalledTimes(1);
      const finalPatch = vi.mocked(queueResume.saveJobDoc).mock.calls.at(-1)![2] as Record<string, unknown>;
      expect(finalPatch).toMatchObject({
        status: "completed",
        "plan.masterR2Key": "renders/job-1/master.mp4",
        billedMinor: 1150,
      });
      expect(result.status).toBe("completed");
    } finally {
      await rm("/tmp/gen3ia-render-test", { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// sweepStaleRenderJobs — couche résiliente + réconciliation opportuniste
// ---------------------------------------------------------------------------

describe("sweepStaleRenderJobs", () => {
  it("utilise queryJobDocs et re-file les orphelins (chemin legacy, budget intact)", async () => {
    vi.mocked(queueResume.queryJobDocs).mockResolvedValue([
      baseJob({
        status: "processing",
        leaseExpiresAt: 0,
        deadlineAt: new Date(Date.now() - 60_000).toISOString(),
      }) as unknown as RenderJob,
    ]);

    const result = await sweepStaleRenderJobs();

    expect(queueResume.queryJobDocs).toHaveBeenCalledWith(JOBS_COLLECTION, "status", "processing");
    expect(result).toEqual({ scanned: 1, requeued: 1, failed: 0 });
    // le sweep appelle failJob SANS politique → chemin legacy (budget intact)
    const patch = vi.mocked(queueResume.saveJobDoc).mock.calls[0][2] as Record<string, unknown>;
    expect(patch.status).toBe("queued");
    expect(patch.retryCount).toBeDefined();
  });

  it("un job au bail VIVANT n'est jamais touché", async () => {
    vi.mocked(queueResume.queryJobDocs).mockResolvedValue([
      baseJob({
        status: "processing",
        leaseExpiresAt: Date.now() + 100_000,
        deadlineAt: new Date(Date.now() + 100_000).toISOString(),
      }) as unknown as RenderJob,
    ]);

    const result = await sweepStaleRenderJobs();

    expect(result).toEqual({ scanned: 1, requeued: 0, failed: 0 });
    expect(queueResume.saveJobDoc).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Lot C4a/C4b (Task 101-c) — gardes structurels de la route GET render
// ────────────────────────────────────────────────────────────────────────────

describe("Lot C4 — GET render : sweep throttlé + relecture conditionnelle (structurel)", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const route = read("app/api/video/projects/[projectId]/render/route.ts");

  it("le sweep n'est plus exécuté à chaque GET : helper throttlé avec sortie immédiate en mode QStash", () => {
    // La route ne balaie plus cross-user à chaque tick : en mode QStash le
    // worker tick (app/api/video/worker/tick/route.ts) est responsable.
    expect(route).toContain("async function sweepRenderJobsIfDue(");
    expect(route).toMatch(/if \(qstashConfig\(\)\) return;/);
    // Le corps du GET ne référence plus le sweep direct : uniquement le
    // helper throttlé (l'ancien appel inconditionnel a disparu).
    const getBlock = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PATCH"));
    expect(getBlock).toContain("await sweepRenderJobsIfDue(projectId);");
    expect(getBlock).not.toContain("sweepStaleRenderJobs");
  });

  it("mode sondage : 1 exécution max/minute via clé Redis partagée + repli mémoire locale", () => {
    expect(route).toContain('`sweep:render:${projectId}`');
    expect(route).toContain("cacheGet<number>(throttleKey)");
    expect(route).toContain("cacheSet(throttleKey, now");
    expect(route).toContain("const localSweepAt = new Map<string, number>();");
    expect(route).toContain("const SWEEP_THROTTLE_MS = 60_000;");
  });

  it("la relecture post-tick n'arrive QUE si le tick a réellement avancé (plus de double listJobs)", () => {
    expect(route).toContain("const ticked = await maybeAdvancePendingJob(");
    expect(route).toContain("if (ticked) jobs = await listJobs(guard.context.userId, projectId);");
  });
});

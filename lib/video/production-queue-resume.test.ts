import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * Tests d'intégration de la reprise QUOTA-AWARE dans production-queue
 * (Task 95-d — miroir de render-queue-resume.test.ts).
 *
 * Patterns : adminDb factice avec runTransaction + état hoisted (comme
 * mission-queue.test.ts), couche résiliente mockée en vi.fn via le mock
 * PARTIEL de queue-resume (classifyTickError / resumePolicyFor restent
 * RÉELS), quotas simulés par code gRPC 8 (classifiés par le vrai quota-guard).
 */

// ---------------------------------------------------------------------------
// État hoisted — Firestore factice (docs + erreur tx)
// ---------------------------------------------------------------------------

const firestoreState = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
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
            firestoreState.docs.set(path, { ...payload });
            return {};
          },
          set: async (payload: Record<string, unknown>, opts?: { merge?: boolean }) => {
            const existing = firestoreState.docs.get(path);
            firestoreState.docs.set(path, opts?.merge === true ? { ...(existing ?? {}), ...payload } : { ...payload });
            return {};
          },
          get: async () => {
            const data = firestoreState.docs.get(path);
            return data ? { exists: true, data: () => data } : { exists: false, data: () => undefined };
          },
        };
      },
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (firestoreState.txError) throw firestoreState.txError;
      return fn({
        get: async (ref: { __path: string }) => {
          const data = firestoreState.docs.get(ref.__path);
          return data ? { exists: true, data: () => data } : { exists: false, data: () => undefined };
        },
        update: (ref: { __path: string }, patch: Record<string, unknown>) => {
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
  createProject: vi.fn(async () => ({ id: "proj-1" })),
  getOwnedProjectOrThrow: vi.fn(),
  patchProject: vi.fn(async () => undefined),
  logSystem: vi.fn(async () => undefined),
}));

vi.mock("@/lib/video/director-service", () => ({
  applyProductionPlan: vi.fn(),
}));

vi.mock("@/lib/video/script-service", () => ({
  generateScript: vi.fn(),
}));

vi.mock("@/lib/video/image-bridge", () => ({
  generateSceneImage: vi.fn(),
}));

vi.mock("@/lib/video/credits", () => ({
  billImageGeneration: vi.fn(async () => undefined),
  billTts: vi.fn(async () => undefined),
}));

vi.mock("@/lib/video/voice-service", () => ({
  resolvePreferredVoice: vi.fn(),
  generateSceneNarration: vi.fn(),
  attachRecordingAsNarration: vi.fn(),
}));

vi.mock("@/lib/video/asset-service", () => ({
  listAssets: vi.fn(async () => []),
}));

vi.mock("@/lib/video/timeline-service", () => ({
  syncVoiceTrack: vi.fn((timeline: unknown) => timeline),
  applyTimelinePatch: vi.fn((timeline: unknown) => timeline),
}));

vi.mock("@/lib/video/audio-engine", () => ({
  ensureMusicBed: vi.fn(),
}));

vi.mock("@/lib/video/storage", () => ({
  isOwnedVideoKey: vi.fn(() => true),
  // Task 107-a — livraison chat : production-queue importe aussi la signature
  // d'URL master (jamais appelée sans conversationId — mocké par complétude).
  createVideoPlaybackUrl: vi.fn(async () => "https://r2.test/presigne/master.mp4"),
}));

vi.mock("@/lib/video/render-queue", () => ({
  startRenderJob: vi.fn(),
  getJob: vi.fn(),
}));

vi.mock("@/lib/notifications/repository", () => ({
  createNotification: vi.fn(async () => undefined),
}));

vi.mock("@/lib/queue/qstash", () => ({
  publishJsonDestination: vi.fn(async () => ({ ok: true, mode: "published", message: "" })),
}));

// ---------------------------------------------------------------------------
// Imports sujet + mocks pour assertions
// ---------------------------------------------------------------------------

import {
  PRODUCTION_JOBS_COLLECTION,
  PRODUCTION_RETRY_BUDGET,
  advanceProductionJob,
  sweepStaleProductionJobs,
} from "./production-queue";
import * as queueResume from "@/lib/video/queue-resume";
import { billImageGeneration, billTts } from "@/lib/video/credits";
import { generateSceneImage } from "@/lib/video/image-bridge";
import { createNotification } from "@/lib/notifications/repository";
import { getOwnedProjectOrThrow, logSystem } from "@/lib/video/project-service";
import { publishJsonDestination } from "@/lib/queue/qstash";

function quotaError(message = "Quota exceeded for quota group 'default'."): Error {
  return Object.assign(new Error(message), { code: 8 });
}

/** Projet factice : 2 scènes à l'étape des visuels. */
const testProject = {
  id: "proj-1",
  userId: "user-1",
  title: "Présentation",
  script: { scenes: [{ id: "s1" }, { id: "s2" }] },
};

/** Document job de base (étape assets, entrée de timeline déjà posée). */
function baseJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job-1",
    userId: "user-1",
    projectId: "proj-1",
    prompt: "Une vidéo de présentation du produit",
    title: "Présentation",
    status: "queued",
    stage: "assets",
    stageIndex: 3,
    progress: 0.35,
    sceneCursor: 0,
    attempts: 1,
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timeline: [{ stage: "assets", startedAt: new Date().toISOString() }],
    ...overrides,
  };
}

function setDoc(job: Record<string, unknown>): void {
  firestoreState.docs.set(`${PRODUCTION_JOBS_COLLECTION}/${job.id as string}`, job);
}

beforeEach(() => {
  firestoreState.docs.clear();
  firestoreState.txError = null;
  vi.clearAllMocks();
  // Origine canonique : publishProductionTick la résout AVANT d'appeler le
  // mock publishJsonDestination (l'ancien paramètre origin a été supprimé).
  process.env.GEN3IA_APP_ORIGIN = "https://gen3ia.online";
  delete process.env.GEN3IA_ALLOWED_ORIGINS;
  vi.mocked(queueResume.saveJobDoc).mockResolvedValue(undefined);
  vi.mocked(queueResume.loadJobDoc).mockResolvedValue(null as never);
  vi.mocked(queueResume.createJobDoc).mockResolvedValue(undefined);
  vi.mocked(queueResume.queryJobDocs).mockResolvedValue([] as never);
  vi.mocked(getOwnedProjectOrThrow).mockResolvedValue(testProject as never);
  vi.mocked(generateSceneImage).mockResolvedValue({ generated: false } as never);
  setDoc(baseJob());
});

afterEach(() => {
  delete process.env.GEN3IA_APP_ORIGIN;
  delete process.env.GEN3IA_ALLOWED_ORIGINS;
});

/** Délai QStash passé au dernier publish (helper de lisibilité). */
function publishDelaySeconds(): number {
  const last = vi.mocked(publishJsonDestination).mock.calls.at(-1);
  return (last?.[2] as { delaySeconds?: number } | undefined)?.delaySeconds ?? -1;
}

// ---------------------------------------------------------------------------
// advanceProductionJob — quota sur un checkpoint : reprise SANS consommer le
// budget (miroir exact du régime « reprise » du rendu)
// ---------------------------------------------------------------------------

describe("advanceProductionJob — erreur de quota sur un checkpoint", () => {
  it("re-file le job SANS consommer retryCount, avec quotaFailures et backoff", async () => {
    // 1er appel saveJobDoc = checkpoint scène → QUOTA ; 2e = ré-file → OK.
    vi.mocked(queueResume.saveJobDoc).mockRejectedValueOnce(quotaError()).mockResolvedValueOnce(undefined);

    const result = await advanceProductionJob("job-1");

    const saveMock = vi.mocked(queueResume.saveJobDoc);
    expect(saveMock).toHaveBeenCalledTimes(2);
    const requeuePatch = saveMock.mock.calls[1][2] as Record<string, unknown>;
    expect(requeuePatch.status).toBe("queued");
    expect(requeuePatch.quotaFailures).toBe(1);
    expect("retryCount" in requeuePatch).toBe(false); // budget INTACT
    expect(requeuePatch.leaseOwner).toBeNull(); // bail libéré (convention production)
    expect(requeuePatch.leaseExpiresAt).toBe(0);
    const delayMs = Date.parse(requeuePatch.nextAttemptAt as string) - Date.parse(requeuePatch.updatedAt as string);
    expect(delayMs).toBeGreaterThanOrEqual(59_000); // backoff 30×2^1=60 s + gigue 0..5 s
    expect(delayMs).toBeLessThanOrEqual(66_000);
    expect(saveMock.mock.calls[1][3]).toBe("user-1"); // ownerId propagé à la couche résiliente
    expect(result.status).toBe("queued");
    expect(result.done).toBe(false);
    expect(result.continued).toBe(true);
    // re-file QStash avec le délai de backoff
    expect(publishDelaySeconds()).toBeGreaterThanOrEqual(60);
    expect(publishDelaySeconds()).toBeLessThanOrEqual(65);
    // JAMAIS d'échec définitif ni de notification pour un quota
    expect(createNotification).not.toHaveBeenCalled();
    // JAMAIS de libération de budget côté production (facturation au réel)
    expect(billImageGeneration).not.toHaveBeenCalled();
    expect(billTts).not.toHaveBeenCalled();
  });

  it("le message stocké est actionnable et mentionne le quota", async () => {
    vi.mocked(queueResume.saveJobDoc).mockRejectedValueOnce(quotaError()).mockResolvedValueOnce(undefined);

    const result = await advanceProductionJob("job-1");

    const requeuePatch = vi.mocked(queueResume.saveJobDoc).mock.calls[1][2] as Record<string, unknown>;
    expect(String(requeuePatch.error)).toMatch(/Quota Firestore épuisé/);
    expect(String(requeuePatch.error)).toMatch(/backoff/);
    expect(result.message).toMatch(/Quota Firestore épuisé/);
    // journal système français de reprise (pas d'alarme utilisateur)
    expect(logSystem).toHaveBeenCalledWith("proj-1", expect.stringMatching(/incident quota Firestore.*reprise automatique dans/));
  });

  it("le checkpoint consolidé déjà écrit survit à l'incident (ré-file sans l'écraser) — Task 106-fix : un checkpoint par tick", async () => {
    vi.mocked(queueResume.saveJobDoc)
      .mockRejectedValueOnce(quotaError()) // checkpoint CONSOLIDÉ du tick → QUOTA (incident Firestore)
      .mockResolvedValue(undefined); // ré-file failProductionJob → OK

    await advanceProductionJob("job-1");

    const calls = vi.mocked(queueResume.saveJobDoc).mock.calls;
    // Task 106-fix : UN SEUL checkpoint consolidé par tick (limite Firestore
    // ~1 écriture/s/doc) — il porte le curseur après les scènes du lot.
    const checkpointCalls = calls.filter((call) => "sceneCursor" in ((call[2] ?? {}) as Record<string, unknown>));
    expect(checkpointCalls.length).toBe(1);
    expect(checkpointCalls[0][2]).toMatchObject({ sceneCursor: 2 });
    // la ré-file ne touche NI sceneCursor NI stage : l'état persisté
    // (checkpoints conservés) sert de point de reprise au tick suivant
    const requeuePatch = calls[calls.length - 1][2] as Record<string, unknown>;
    expect("sceneCursor" in requeuePatch).toBe(false);
    expect("stage" in requeuePatch).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// failProductionJob — chemin legacy fatal PRÉSERVÉ (sans politique)
// ---------------------------------------------------------------------------

describe("failProductionJob — chemin legacy inchangé", () => {
  it("sous le budget : re-file 20 s avec retryCount incrémenté (incrément numérique historique)", async () => {
    vi.mocked(generateSceneImage).mockRejectedValue(new Error("Incident moteur de visuels"));

    const result = await advanceProductionJob("job-1");

    const saveMock = vi.mocked(queueResume.saveJobDoc);
    expect(saveMock).toHaveBeenCalledTimes(1);
    const patch = saveMock.mock.calls[0][2] as Record<string, unknown>;
    expect(patch.status).toBe("queued");
    expect(patch.retryCount).toBe(1); // incrément NUMÉRIQUE (comportement historique)
    expect("quotaFailures" in patch).toBe(false);
    expect("nextAttemptAt" in patch).toBe(false);
    expect(createNotification).not.toHaveBeenCalled();
    expect(result.status).toBe("queued");
    expect(result.done).toBe(false);
    // re-file QStash avec le délai legacy de 20 s
    expect(publishDelaySeconds()).toBe(20);
    expect(logSystem).toHaveBeenCalledWith("proj-1", expect.stringMatching(/relance 1\/3/));
  });

  it("au budget (3) : échec définitif + notification, sans libération côté production", async () => {
    setDoc(baseJob({ retryCount: PRODUCTION_RETRY_BUDGET }));
    vi.mocked(generateSceneImage).mockRejectedValue(new Error("Incident moteur de visuels"));

    const result = await advanceProductionJob("job-1");

    const saveMock = vi.mocked(queueResume.saveJobDoc);
    const failedPatch = saveMock.mock.calls
      .map((call) => call[2] as Record<string, unknown>)
      .find((patch) => patch.status === "failed");
    expect(failedPatch).toMatchObject({ status: "failed" });
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", title: "Production vidéo échouée" }),
    );
    expect(result.status).toBe("failed");
    expect(result.done).toBe(true);
    // pas de re-file après un échec définitif
    expect(publishJsonDestination).not.toHaveBeenCalled();
    // la production ne libère AUCUN budget (facturation au réel, rendu séparé)
    expect(billImageGeneration).not.toHaveBeenCalled();
    expect(billTts).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// claim — renonciation sous quota (Task 108 : plus de failover miroir)
// ---------------------------------------------------------------------------

describe("claimProductionJob — renonciation sous quota (Task 108)", () => {
  it("transaction en quota → erreur de quota PROPAGÉE (le tick est republié avec délai)", async () => {
    firestoreState.txError = quotaError();
    await expect(advanceProductionJob("job-1")).rejects.toThrow(/Quota exceeded/);
    // aucune écriture de checkpoint au passage (rien n'a avancé)
    expect(queueResume.saveJobDoc).not.toHaveBeenCalled();
  });

  it("erreur transitoire de transaction : propagation inchangée", async () => {
    firestoreState.txError = Object.assign(new Error("Le service est actuellement indisponible."), { code: 14 });
    await expect(advanceProductionJob("job-1")).rejects.toThrow(/indisponible/);
  });
});

// ---------------------------------------------------------------------------
// sweepStaleProductionJobs — reprise des orphelins via la couche résiliente
// ---------------------------------------------------------------------------

describe("sweepStaleProductionJobs", () => {
  it("utilise queryJobDocs et re-file les orphelins (chemin legacy, budget intact)", async () => {
    vi.mocked(queueResume.queryJobDocs).mockResolvedValue([
      baseJob({
        status: "processing",
        leaseOwner: "job-1:ancien",
        leaseExpiresAt: 0,
        updatedAt: new Date(Date.now() - 600_000).toISOString(), // > 2× bail
      }) as never,
    ]);

    const result = await sweepStaleProductionJobs();

    expect(queueResume.queryJobDocs).toHaveBeenCalledWith(PRODUCTION_JOBS_COLLECTION, "status", "processing");
    expect(result).toEqual({ scanned: 1, requeued: 1, failed: 0 });
    // le sweep appelle failProductionJob SANS politique → chemin legacy (budget intact)
    const patch = vi.mocked(queueResume.saveJobDoc).mock.calls[0][2] as Record<string, unknown>;
    expect(patch.status).toBe("queued");
    expect(patch.retryCount).toBe(1);
  });

  it("un job au bail VIVANT n'est jamais touché", async () => {
    vi.mocked(queueResume.queryJobDocs).mockResolvedValue([
      baseJob({
        status: "processing",
        leaseExpiresAt: Date.now() + 100_000,
      }) as never,
    ]);

    const result = await sweepStaleProductionJobs();

    expect(result).toEqual({ scanned: 1, requeued: 0, failed: 0 });
    expect(queueResume.saveJobDoc).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Lot C4a (Task 101-c) — garde structurel de la route GET production
// ────────────────────────────────────────────────────────────────────────────

describe("Lot C4 — GET production : sweep throttlé (structurel)", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const route = read("app/api/video/projects/[projectId]/production/route.ts");

  it("le sweep n'est plus exécuté à chaque GET : helper throttlé avec sortie immédiate en mode QStash", () => {
    expect(route).toContain("async function sweepProductionJobsIfDue(");
    expect(route).toMatch(/if \(qstashConfig\(\)\) return;/);
    // Le corps du GET (dernière fonction de la route) ne référence plus le
    // sweep direct : uniquement le helper throttlé (défini AVANT le GET,
    // l'ancien appel inconditionnel a disparu).
    const getBlock = route.slice(route.indexOf("export async function GET"));
    expect(getBlock).toContain("await sweepProductionJobsIfDue(projectId);");
    expect(getBlock).not.toContain("sweepStaleProductionJobs");
  });

  it("mode sondage : 1 exécution max/minute via clé Redis partagée + repli mémoire locale", () => {
    expect(route).toContain('`sweep:production:${projectId}`');
    expect(route).toContain("cacheGet<number>(throttleKey)");
    expect(route).toContain("cacheSet(throttleKey, now");
    expect(route).toContain("const localSweepAt = new Map<string, number>();");
    expect(route).toContain("const SWEEP_THROTTLE_MS = 60_000;");
  });
});

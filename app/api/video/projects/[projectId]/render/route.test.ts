import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/video/projects/[projectId]/render — FIX « gen3 construit la
 * vidéo mais il ne l'envoie jamais » (capture production 2026-11-13 17:15 :
 * carte du fil bloquée sur « finalisation (100 %) » pendant que le message
 * annonçait « Votre vidéo est prête »).
 *
 * CONTRAT : l'instantané PROCESSUS-LOCAL de progression (TTL 24 h) ne doit
 * JAMAIS masquer un job TERMINAL du document Firestore — un `processing`
 * figé écrasait `completed` et le lecteur <video> du fil ne se résolvait
 * plus jamais. Le point de vérité reste le document (progress-store.ts).
 */

const protectMock = vi.fn();
const listJobsMock = vi.fn();
const maybeAdvanceMock = vi.fn();
const sweepMock = vi.fn();
const tickQueueConfiguredMock = vi.fn();
const getJobProgressMock = vi.fn();
const createPlaybackMock = vi.fn();
const cacheGetMock = vi.fn();
const cacheSetMock = vi.fn();

vi.mock("@/lib/security/route-guard", () => ({
  protectRoute: (...args: unknown[]) => protectMock(...args),
}));

vi.mock("@/lib/video/render-queue", () => ({
  startRenderJob: vi.fn(),
  listJobs: (...args: unknown[]) => listJobsMock(...args),
  pauseJob: vi.fn(),
  resumeJob: vi.fn(),
  cancelJob: vi.fn(),
  sweepStaleRenderJobs: (...args: unknown[]) => sweepMock(...args),
  maybeAdvancePendingJob: (...args: unknown[]) => maybeAdvanceMock(...args),
  POLL_ADVANCE_BUDGET_MS: 55_000,
}));

vi.mock("@/lib/video/ffmpeg", () => ({
  checkFfmpegAvailable: vi.fn(async () => ({ ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe" })),
}));

vi.mock("@/lib/video/progress-store", () => ({
  getJobProgress: (...args: unknown[]) => getJobProgressMock(...args),
  setJobProgress: vi.fn(),
}));

vi.mock("@/lib/queue/tick-queue", () => ({
  tickQueueConfigured: () => tickQueueConfiguredMock(),
}));

vi.mock("@/lib/cache/redis", () => ({
  cacheGet: (...args: unknown[]) => cacheGetMock(...args),
  cacheSet: (...args: unknown[]) => cacheSetMock(...args),
}));

vi.mock("@/lib/video/storage", () => ({
  createVideoPlaybackUrl: (...args: unknown[]) => createPlaybackMock(...args),
  isOwnedVideoKey: vi.fn(() => true),
}));

import { GET } from "./route";

const CONTEXT = { userId: "u1", email: "u@gen3ia.io", claims: {}, traceId: "t1" };

function ok() {
  return { ok: true as const, context: CONTEXT };
}

function request(): NextRequest {
  return new NextRequest("https://gen3ia.local/api/video/projects/p1/render", { method: "GET" });
}

const ROUTE_CONTEXT = { params: Promise.resolve({ projectId: "p1" }) };

/** Job Firestore TERMINAL porteur du master (source de vérité). */
const COMPLETED_JOB = {
  id: "job-1",
  userId: "u1",
  projectId: "p1",
  status: "completed" as const,
  stage: "finalize" as const,
  progress: 1,
  exports: [],
  output: { r2Key: "users/u1/video/p1/renders/master.mp4", sizeBytes: 2_000_000, durationSec: 10, width: 1920, height: 1080 },
};

/** Instantané STALE (le bug : écrit au début de l'étape finalize, jamais purgé). */
const SNAPSHOT_STALE = { progress: 0.99, status: "processing", stage: "finalize", updatedAt: Date.now() };

beforeEach(() => {
  vi.clearAllMocks();
  protectMock.mockResolvedValue(ok());
  maybeAdvanceMock.mockResolvedValue(null);
  sweepMock.mockResolvedValue(undefined);
  tickQueueConfiguredMock.mockReturnValue(true); // mode file : sweep retiré du GET
  cacheGetMock.mockResolvedValue(undefined);
  cacheSetMock.mockResolvedValue(undefined);
  createPlaybackMock.mockImplementation(async (_uid: string, key: string) => `https://r2.test/${key}?sig=fraiche`);
  getJobProgressMock.mockResolvedValue(null);
  listJobsMock.mockResolvedValue([COMPLETED_JOB]);
});

describe("GET .../render — l'instantané local ne masque JAMAIS un job terminal", () => {
  it("job completed + instantané stale `processing` → status Firestore gagne, playbackUrl présent", async () => {
    getJobProgressMock.mockResolvedValue(SNAPSHOT_STALE);

    const response = await GET(request(), ROUTE_CONTEXT);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { jobs: Array<{ id: string; status: string; output?: { playbackUrl?: string } }> };

    expect(body.jobs).toHaveLength(1);
    const job = body.jobs[0];
    expect(job.id).toBe("job-1");
    expect(job.status).toBe("completed"); // PAS "processing" (instantané écarté)
    expect(job.output?.playbackUrl).toContain("users/u1/video/p1/renders/master.mp4");
    expect(job.output?.playbackUrl).toContain("sig=fraiche"); // présignée FRAÎCHE
    // La signature du master a bien été demandée (lecteur résoluble).
    expect(createPlaybackMock).toHaveBeenCalledWith("u1", "users/u1/video/p1/renders/master.mp4", 900);
  });

  it("job completed SANS instantané → status Firestore + playbackUrl (comportement nominal inchangé)", async () => {
    getJobProgressMock.mockResolvedValue(null);

    const response = await GET(request(), ROUTE_CONTEXT);
    const body = (await response.json()) as { jobs: Array<{ status: string }> };
    expect(body.jobs[0].status).toBe("completed");
    expect(body.jobs[0] && "output" in body.jobs[0]).toBe(true);
  });

  it("job EN COURS + instantané frais → l'instantané enrichit (progression temps réel conservée)", async () => {
    const runningJob = { ...COMPLETED_JOB, id: "job-2", status: "processing" as const, stage: "segments" as const, progress: 0.4, output: undefined };
    listJobsMock.mockResolvedValue([runningJob]);
    getJobProgressMock.mockResolvedValue({ progress: 0.52, status: "processing", stage: "segments", updatedAt: Date.now() });

    const response = await GET(request(), ROUTE_CONTEXT);
    const body = (await response.json()) as { jobs: Array<{ id: string; status: string; progress: number }> };
    expect(body.jobs[0].id).toBe("job-2");
    expect(body.jobs[0].status).toBe("processing");
    expect(body.jobs[0].progress).toBe(0.52); // instantané plus frais que Firestore
  });

  it("job FAILED + instantané stale `processing` → status Firestore gagne (échec affiché honnêtement)", async () => {
    const failedJob = { ...COMPLETED_JOB, id: "job-3", status: "failed" as const, output: undefined };
    listJobsMock.mockResolvedValue([failedJob]);
    getJobProgressMock.mockResolvedValue(SNAPSHOT_STALE);

    const response = await GET(request(), ROUTE_CONTEXT);
    const body = (await response.json()) as { jobs: Array<{ status: string }> };
    expect(body.jobs[0].status).toBe("failed");
  });
});

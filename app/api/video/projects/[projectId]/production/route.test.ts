import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/video/projects/[projectId]/production — FIX « gen3 construit la
 * vidéo mais il ne l'envoie jamais » (capture production 2026-11-13 17:15 :
 * « Votre vidéo est prête » + carte figée sur « finalisation (100 %) »).
 *
 * CONTRAT : le statut de production expose le master en URL durable
 * RELATIVE (/api/media/durable?path=…) dès qu'il existe — la carte du fil
 * monte le lecteur <video> en UN SEUL saut (cookie de session automatique,
 * re-signature fraîche à chaque résolution), sans dépendre de la chaîne
 * GET .../render + présignature R2 qui trébuchait en production. Le statut
 * effectif « processing / stage=done + rendu terminé » (écriture terminale
 * Firestore indisponible) expose AUSSI le lecteur.
 */

const protectMock = vi.fn();
const getOwnedProjectMock = vi.fn();
const listProductionJobsMock = vi.fn();
const deliverMock = vi.fn();
const sweepProductionMock = vi.fn();
const maybeAdvanceProductionMock = vi.fn();
const getRenderJobMock = vi.fn();
const tickQueueConfiguredMock = vi.fn();
const nudgePumpMock = vi.fn();
const writeCheckpointMock = vi.fn();
const cacheGetMock = vi.fn();
const cacheSetMock = vi.fn();

vi.mock("@/lib/security/route-guard", () => ({
  protectRoute: (...args: unknown[]) => protectMock(...args),
}));

vi.mock("@/lib/video/project-service", () => ({
  getOwnedProjectOrThrow: (...args: unknown[]) => getOwnedProjectMock(...args),
  logSystem: vi.fn(async () => undefined),
}));

vi.mock("@/lib/video/production-queue", () => ({
  deliverJobToConversation: (...args: unknown[]) => deliverMock(...args),
  listProductionJobs: (...args: unknown[]) => listProductionJobsMock(...args),
  sweepStaleProductionJobs: (...args: unknown[]) => sweepProductionMock(...args),
  maybeAdvancePendingProductionJob: (...args: unknown[]) => maybeAdvanceProductionMock(...args),
  PRODUCTION_POLL_ADVANCE_BUDGET_MS: 100_000,
  PRODUCTION_JOBS_COLLECTION: "videoProductionJobs",
}));

vi.mock("@/lib/video/render-queue", () => ({
  getJob: (...args: unknown[]) => getRenderJobMock(...args),
}));

vi.mock("@/lib/db/firestore-resilient", () => ({
  writeCheckpointSet: (...args: unknown[]) => writeCheckpointMock(...args),
}));

vi.mock("@/lib/queue/tick-queue", () => ({
  tickQueueConfigured: () => tickQueueConfiguredMock(),
  nudgePumpFromPolling: () => nudgePumpMock(),
}));

vi.mock("@/lib/cache/redis", () => ({
  cacheGet: (...args: unknown[]) => cacheGetMock(...args),
  cacheSet: (...args: unknown[]) => cacheSetMock(...args),
}));

import { GET } from "./route";

const CONTEXT = { userId: "u1", email: "u@gen3ia.io", claims: {}, traceId: "t1" };

function ok() {
  return { ok: true as const, context: CONTEXT };
}

function request(): NextRequest {
  return new NextRequest("https://gen3ia.local/api/video/projects/p1/production", { method: "GET" });
}

const ROUTE_CONTEXT = { params: Promise.resolve({ projectId: "p1" }) };

const PROJET = { id: "p1", userId: "u1", title: "Chat qui danse" };

/** Job de production terminé (statut stocké propre). */
const JOB_COMPLETED = {
  id: "prod-1",
  userId: "u1",
  projectId: "p1",
  title: "Chat qui danse",
  status: "completed" as const,
  stage: "done" as const,
  stageIndex: 6,
  progress: 1,
  error: null,
  renderJobId: "job-1",
  timeline: {},
  sceneCursor: 3,
  warnings: [],
  createdAt: "2026-11-13T09:00:00.000Z",
  updatedAt: "2026-11-13T09:05:00.000Z",
};

const RENDER_JOB = {
  id: "job-1",
  status: "completed" as const,
  output: { r2Key: "users/u1/video/p1/renders/master.mp4", sizeBytes: 2_000_000, durationSec: 10, width: 1920, height: 1080 },
};

beforeEach(() => {
  vi.clearAllMocks();
  protectMock.mockResolvedValue(ok());
  getOwnedProjectMock.mockResolvedValue(PROJET);
  tickQueueConfiguredMock.mockReturnValue(true);
  nudgePumpMock.mockReturnValue(undefined);
  writeCheckpointMock.mockResolvedValue(undefined);
  deliverMock.mockResolvedValue(undefined);
  sweepProductionMock.mockResolvedValue(undefined);
  maybeAdvanceProductionMock.mockResolvedValue(null);
  cacheGetMock.mockResolvedValue(undefined);
  cacheSetMock.mockResolvedValue(undefined);
  getRenderJobMock.mockResolvedValue(RENDER_JOB);
  listProductionJobsMock.mockResolvedValue([JOB_COMPLETED]);
});

describe("GET .../production — lecteur durable du master (un seul saut)", () => {
  it("job completed + rendu terminé → masterUrl = /api/media/durable?path=… (relatif, même origine)", async () => {
    const response = await GET(request(), ROUTE_CONTEXT);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; masterUrl: string | null };

    expect(body.status).toBe("completed");
    expect(body.masterUrl).toBe(
      `/api/media/durable?path=${encodeURIComponent("users/u1/video/p1/renders/master.mp4")}`,
    );
    // RELATIVE (cookie de session automatique) — jamais une présignée R2.
    expect(body.masterUrl?.startsWith("/")).toBe(true);
    expect(body.masterUrl).not.toContain("X-Amz");
  });

  it("statut effectif processing/stage=done + rendu terminé → status completed + masterUrl + livraison", async () => {
    const jobSticky = { ...JOB_COMPLETED, id: "prod-2", status: "processing" as const, progress: 0.99, renderJobId: "job-1" };
    listProductionJobsMock.mockResolvedValue([jobSticky]);

    const response = await GET(request(), ROUTE_CONTEXT);
    const body = (await response.json()) as { status: string; progress: number; masterUrl: string | null };

    expect(body.status).toBe("completed"); // effectif — le client voit la vidéo finie
    expect(body.progress).toBe(1);
    expect(body.masterUrl).toContain("/api/media/durable?path=");
    // La livraison chat a bien été tentée sur le statut effectif (filet).
    expect(deliverMock).toHaveBeenCalledTimes(1);
    const livre = deliverMock.mock.calls[0]?.[0] as { status: string; progress: number };
    expect(livre.status).toBe("completed");
    expect(livre.progress).toBe(1);
  });

  it("job completed mais rendu illisible (quota) → masterUrl null, le reste de la réponse reste saine", async () => {
    getRenderJobMock.mockRejectedValue(new Error("Quota Firestore épuisé."));

    const response = await GET(request(), ROUTE_CONTEXT);
    const body = (await response.json()) as { status: string; masterUrl: string | null };
    expect(response.status).toBe(200);
    expect(body.status).toBe("completed");
    expect(body.masterUrl).toBeNull();
  });

  it("job EN COURS → masterUrl absent (le master n'existe pas encore)", async () => {
    const jobRunning = { ...JOB_COMPLETED, id: "prod-3", status: "processing" as const, stage: "assets" as const, progress: 0.4, renderJobId: null };
    listProductionJobsMock.mockResolvedValue([jobRunning]);

    const response = await GET(request(), ROUTE_CONTEXT);
    const body = (await response.json()) as { status: string; masterUrl: string | null };
    expect(body.status).toBe("processing");
    expect(body.masterUrl).toBeNull();
    expect(getRenderJobMock).not.toHaveBeenCalled();
  });
});

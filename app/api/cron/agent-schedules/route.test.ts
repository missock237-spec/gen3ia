import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

/**
 * Task 107-a — étape « video-sweep » du dispatcher quotidien : les files
 * vidéo (production autopilote + rendu) sont balayées à CHAQUE passage du
 * cron /api/cron/agent-schedules — les jobs orphelins (bail expiré, worker
 * tué, tick perdu) sont ré-enfilés même quand le chat est fermé (mode
 * sondage). L'étape est BEST-EFFORT : un incident alimente `partialFailures`
 * sans jamais faire échouer la route (contrat des autres étapes).
 *
 * Toutes les dépendances sont simulées : on teste uniquement le câblage de
 * l'étape (invocation, forme de la réponse, propagation des incidents).
 */

vi.mock("@/lib/agents/scheduler", () => ({
  dispatchSchedules: vi.fn(async () => ({ checked: 0, due: 0, executed: [] })),
}));

vi.mock("@/lib/voice/renewals", () => ({
  renewDueNumbers: vi.fn(async () => ({ renewed: 0 })),
  reactivateNumbersInGrace: vi.fn(async () => ({ reactivated: 0 })),
}));

vi.mock("@/lib/extensions/subscriptions", () => ({
  renewDueExtensionSubscriptions: vi.fn(async () => ({ renewed: 0 })),
}));

vi.mock("@/lib/queue/dispatch-loop", () => ({
  scheduleNextDispatchTick: vi.fn(async () => ({ scheduled: true })),
  slotFor: vi.fn(() => "2025-01-01:start0"),
}));

vi.mock("@/lib/queue/qstash", () => ({
  publishDispatchTick: vi.fn(async () => ({ ok: true, mode: "published", message: "" })),
}));

vi.mock("@/lib/video/production-queue", () => ({
  sweepStaleProductionJobs: vi.fn(async () => ({ scanned: 2, requeued: 1, failed: 0 })),
}));

vi.mock("@/lib/video/render-queue", () => ({
  sweepStaleRenderJobs: vi.fn(async () => ({ scanned: 3, requeued: 2, failed: 0 })),
}));

import { sweepStaleProductionJobs } from "@/lib/video/production-queue";
import { sweepStaleRenderJobs } from "@/lib/video/render-queue";
import { GET } from "./route";

function authorizedRequest(): NextRequest {
  return new NextRequest("https://gen3ia.local/api/cron/agent-schedules", {
    method: "GET",
    headers: { authorization: "Bearer cron-secret-test" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "cron-secret-test";
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("GET /api/cron/agent-schedules — étape video-sweep (Task 107-a)", () => {
  it("invoque les DEUX sweeps vidéo (production + rendu) et les expose dans videoSweep", async () => {
    const response = await GET(authorizedRequest());

    expect(response.status).toBe(200);
    expect(sweepStaleProductionJobs).toHaveBeenCalledTimes(1);
    expect(sweepStaleRenderJobs).toHaveBeenCalledTimes(1);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.videoSweep).toEqual({
      production: { scanned: 2, requeued: 1, failed: 0 },
      render: { scanned: 3, requeued: 2, failed: 0 },
    });
    // Aucun incident → pas de clé partialFailures (contrat existant).
    expect(body.partialFailures).toBeUndefined();
  });

  it("un échec du sweep apparaît dans partialFailures SANS faire échouer la route", async () => {
    vi.mocked(sweepStaleProductionJobs).mockRejectedValueOnce(new Error("Firestore indisponible"));

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.videoSweep).toBeNull();
    expect(body.partialFailures).toEqual([expect.stringMatching(/^video-sweep: Firestore indisponible$/)]);
    // Les étapes précédentes continuent de tourner (contrat failures[]).
    expect(body.dispatchLoop).toEqual({ scheduled: true });
  });

  it("sans autorisation → 401 et AUCUN sweep (même garde CRON_SECRET)", async () => {
    const unauthorized = new NextRequest("https://gen3ia.local/api/cron/agent-schedules", { method: "GET" });

    const response = await GET(unauthorized);

    expect(response.status).toBe(401);
    expect(sweepStaleProductionJobs).not.toHaveBeenCalled();
    expect(sweepStaleRenderJobs).not.toHaveBeenCalled();
  });
});

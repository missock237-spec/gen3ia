import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGNES_VIDEO_MODEL,
  agnesVideoCostEur,
  createVideoTask,
  generateVideo,
  isVideoUnavailableError,
  isVideoGenerationEnabled,
  areSceneClipsEnabled,
  videoSizeForResolution,
  videoAspectRatioFor,
  VideoGenerationError,
} from "./video-generation";

// Le module lit AGNES_API_KEY à l'exécution : environnement maîtrisé par test.
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("video-generation — Agnes Video 2.5", () => {
  beforeEach(() => {
    process.env.AGNES_API_KEY = "test-key";
    process.env.GEN3IA_VIDEO_POLL_INTERVAL_MS = "10";
    delete process.env.GEN3IA_VIDEO_CLIPS_ENABLED;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.AGNES_API_KEY;
    delete process.env.GEN3IA_VIDEO_POLL_INTERVAL_MS;
  });

  it("détecte l'activation (clé présente + levier métier par défaut)", () => {
    expect(isVideoGenerationEnabled()).toBe(true);
    expect(areSceneClipsEnabled()).toBe(true);
    process.env.GEN3IA_VIDEO_CLIPS_ENABLED = "0";
    expect(areSceneClipsEnabled()).toBe(false);
    delete process.env.GENESIA_VIDEO_CLIPS_ENABLED;
    delete process.env.GEN3IA_VIDEO_CLIPS_ENABLED;
    delete process.env.AGNES_API_KEY;
    expect(isVideoGenerationEnabled()).toBe(false);
  });

  it("map la résolution projet vers le palier de sortie Agnes (1440p → 2K)", () => {
    expect(videoSizeForResolution("480p")).toBe("720P");
    expect(videoSizeForResolution("720p")).toBe("720P");
    expect(videoSizeForResolution("1080p")).toBe("1080P");
    expect(videoSizeForResolution("1440p")).toBe("2K");
    expect(videoSizeForResolution("4K")).toBe("2K");
  });

  it("map le ratio 4:5 vers le ratio vertical supporté 3:4", () => {
    expect(videoAspectRatioFor("4:5")).toBe("3:4");
    expect(videoAspectRatioFor("16:9")).toBe("16:9");
    expect(videoAspectRatioFor("21:9")).toBe("21:9");
  });

  it("calcule le coût externe par seconde selon le palier (tarifs Agnes)", () => {
    expect(agnesVideoCostEur(10, "720P")).toBeCloseTo(0.25, 6);
    expect(agnesVideoCostEur(10, "1080P")).toBeCloseTo(0.4, 6);
    expect(agnesVideoCostEur(8, "2K")).toBeCloseTo(0.44, 6);
    expect(agnesVideoCostEur(0, "1080P")).toBe(0);
  });

  it("refuse de créer une tâche sans clé (NOT_CONFIGURED)", async () => {
    delete process.env.AGNES_API_KEY;
    await expect(
      createVideoTask({ prompt: "Une rue sous la pluie", mode: "text", seconds: 5, size: "720P" }),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("refuse le mode keyframe sans image (INVALID_MEDIA)", async () => {
    await expect(
      createVideoTask({ prompt: "Une rue sous la pluie", mode: "keyframe", seconds: 5, size: "720P" }),
    ).rejects.toMatchObject({ code: "INVALID_MEDIA" });
  });

  it("crée une tâche : corps conforme à l'API (seconds en chaîne, mode keyframe, first_frame)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ id: "task_1", task_id: "task_1", video_id: "video_1", status: "queued" }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const created = await createVideoTask({
      prompt: "Un marché animé à Yaoundé",
      mode: "keyframe",
      seconds: 8,
      size: "1080P",
      firstFrameUrl: "https://example.com/img.png",
    });
    expect(created.videoId).toBe("video_1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/videos");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(AGNES_VIDEO_MODEL);
    expect(body.seconds).toBe("8");
    expect(body.mode).toBe("keyframe");
    expect(body.first_frame).toBe("https://example.com/img.png");
    expect(body.size).toBe("1080P");
  });

  it("borne la durée demandée aux bornes API (4–12 s)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ id: "task_1", video_id: "video_1", status: "queued" }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await createVideoTask({ prompt: "Paysage", mode: "text", seconds: 90, size: "720P" });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.seconds).toBe("12");
  });

  it("cycle complet : création + polling jusqu'à completed → URL du MP4", async () => {
    let polls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/videos")) {
        return jsonResponse({ id: "task_9", video_id: "video_9", status: "queued", progress: 0 });
      }
      polls += 1;
      if (polls === 1) return jsonResponse({ status: "in_progress", progress: 40 });
      return jsonResponse({ status: "completed", progress: 100, url: "https://cdn.example.com/out.mp4", seconds: "6" });
    }) as unknown as typeof fetch;

    const result = await generateVideo({ prompt: "Une savane au lever du soleil", mode: "text", seconds: 6, size: "720P" });
    expect(result.videoUrl).toBe("https://cdn.example.com/out.mp4");
    expect(result.seconds).toBe(6);
    expect(result.model).toBe(AGNES_VIDEO_MODEL);
    expect(polls).toBe(2);
  });

  it("échec côté fournisseur → VideoGenerationError UPSTREAM avec message", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/videos")) {
        return jsonResponse({ id: "task_x", video_id: "video_x", status: "queued" });
      }
      return jsonResponse({ status: "failed", error: { message: "Invalid reference media" } });
    }) as unknown as typeof fetch;

    await expect(
      generateVideo({ prompt: "Un chat qui danse", mode: "text", seconds: 5, size: "720P" }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("backoff sur 429 de sondage : la tâche n'est PAS abandonnée", async () => {
    let polls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/videos")) {
        return jsonResponse({ id: "task_r", video_id: "video_r", status: "queued" });
      }
      polls += 1;
      if (polls <= 2) return new Response("rate limit", { status: 429 });
      return jsonResponse({ status: "completed", progress: 100, url: "https://cdn.example.com/ok.mp4" });
    }) as unknown as typeof fetch;

    const result = await generateVideo({ prompt: "Une ville la nuit", mode: "text", seconds: 5, size: "720P" });
    expect(result.videoUrl).toBe("https://cdn.example.com/ok.mp4");
    expect(polls).toBe(3);
  });

  it("classify : seules les indisponibilités (pas les 400) ouvrent le repli", () => {
    expect(isVideoUnavailableError(new VideoGenerationError("UPSTREAM_ERROR", "boom"))).toBe(true);
    expect(isVideoUnavailableError(new VideoGenerationError("TIMEOUT", "trop long"))).toBe(true);
    expect(isVideoUnavailableError(new VideoGenerationError("NOT_CONFIGURED", "pas de clé"))).toBe(true);
    expect(isVideoUnavailableError(new VideoGenerationError("RATE_LIMITED", "429"))).toBe(true);
    expect(isVideoUnavailableError(new VideoGenerationError("INVALID_PROMPT", "prompt invalide"))).toBe(false);
    expect(isVideoUnavailableError(new Error("autre"))).toBe(false);
  });
});

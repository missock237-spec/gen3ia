import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks des dépendances lourdes (wallet, assets, IA, stockage) ────────────
// Les factories vi.mock sont hoistées : les instances vi.fn vivent DANS la
// factory et sont récupérées par import du module mocké après le hoisting.
vi.mock("@/lib/billing/wallet", () => ({
  reserveFunds: vi.fn(async () => ({})),
  settleReservation: vi.fn(async () => ({})),
  releaseReservation: vi.fn(async () => ({})),
}));

vi.mock("@/lib/video/asset-service", () => ({
  registerAsset: vi.fn(),
  listAssets: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@/lib/video/image-bridge", () => ({
  findSceneImage: vi.fn(),
  generateSceneImage: vi.fn(),
}));

vi.mock("@/lib/video/storage", () => ({
  createVideoPlaybackUrl: vi.fn(async () => "https://r2.example.com/signed?token=1"),
}));

vi.mock("@/lib/ai/video-generation", () => ({
  generateVideo: vi.fn(),
  isVideoGenerationEnabled: vi.fn(() => true),
  areSceneClipsEnabled: vi.fn(() => true),
  videoSizeForResolution: vi.fn(() => "1080P"),
  videoAspectRatioFor: vi.fn(() => "16:9"),
  agnesVideoCostEur: vi.fn(() => 0.32),
  MAX_CLIP_SECONDS: 12,
  MIN_CLIP_SECONDS: 4,
  isVideoUnavailableError: vi.fn(() => false),
  createVideoTask: vi.fn(),
  awaitVideoTask: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: () => ({
      where: () => ({
        get: async () => ({ docs: [] }),
      }),
    }),
  },
}));

import { reserveFunds, settleReservation, releaseReservation } from "@/lib/billing/wallet";
import { registerAsset, listAssets } from "@/lib/video/asset-service";
import { findSceneImage, generateSceneImage } from "@/lib/video/image-bridge";
import { createVideoPlaybackUrl } from "@/lib/video/storage";
import {
  generateVideo as agnesGenerateVideo,
  createVideoTask as agnesCreateVideoTask,
  awaitVideoTask as agnesAwaitVideoTask,
  isVideoGenerationEnabled,
  isVideoUnavailableError,
} from "@/lib/ai/video-generation";

import {
  buildSceneMotionPrompt,
  clipSecondsForScene,
  generateSceneVideo,
  generateAllSceneVideos,
  sceneVideoRole,
  startSceneVideoTask,
  awaitSceneVideoTask,
} from "./scene-video-service";
import type { ScriptScene, VideoProject } from "@/lib/video/types";

const walletMock = vi.mocked({ reserveFunds, settleReservation, releaseReservation });
const assetServiceMock = vi.mocked({ registerAsset, listAssets });
const imageBridgeMock = vi.mocked({ findSceneImage, generateSceneImage });
const storageMock = vi.mocked({ createVideoPlaybackUrl });
const agnesMock = vi.mocked({
  generateVideo: agnesGenerateVideo,
  createVideoTask: agnesCreateVideoTask,
  awaitVideoTask: agnesAwaitVideoTask,
  isVideoGenerationEnabled,
  isVideoUnavailableError,
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeScene(overrides: Partial<ScriptScene> = {}): ScriptScene {
  return {
    id: "scene_001",
    chapterId: "ch_1",
    index: 0,
    durationSec: 8,
    narration: "Une savane dorée au lever du soleil, un lion se lève lentement.",
    visualPrompt: "savana at golden hour, a majestic lion rising, warm backlight",
    visualType: "image",
    cameraMotion: "slow_zoom",
    transitionIn: "cut",
    transitionOut: "cut",
    soundEffects: ["wind"],
    captions: true,
    startSec: 0,
    ...overrides,
  };
}

function makeProject(): VideoProject {
  return {
    id: "proj-1",
    userId: "user-1",
    title: "Doc",
    aspectRatio: "16:9",
    resolution: "1080p",
    fps: 30,
    targetDurationSec: 60,
    style: "documentaire cinématographique",
    language: "fr",
    voicePreference: { kind: "auto" },
    status: "draft",
    visualBible: {
      styleDescriptors: "cinematic photography, high detail",
      palette: "warm golden tones",
      characters: [],
      locations: [],
    },
    productionLog: [],
    versionCounter: 1,
    stats: { sceneCount: 1, assetCount: 0, renderedSeconds: 0, qcRounds: 0, billedMinor: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as VideoProject;
}

function makeImageAsset() {
  return {
    id: "img-asset-1",
    projectId: "proj-1",
    userId: "user-1",
    kind: "image",
    role: "scene:scene_001",
    label: "Image scene_001",
    r2Key: "users/user-1/projects/proj-1/images/scene_001.png",
    contentType: "image/png",
    sizeBytes: 1024,
    origin: "generated",
    sceneId: "scene_001",
    createdAt: new Date().toISOString(),
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  assetServiceMock.listAssets.mockResolvedValue([]);
  imageBridgeMock.findSceneImage.mockResolvedValue(makeImageAsset() as never);
  imageBridgeMock.generateSceneImage.mockResolvedValue({ sceneId: "scene_001", assetId: "img-asset-1", generated: true, reused: false } as never);
  storageMock.createVideoPlaybackUrl.mockResolvedValue("https://r2.example.com/signed?token=1");
  agnesMock.generateVideo.mockResolvedValue({
    videoUrl: "https://cdn.example.com/clip.mp4",
    model: "agnes-video-2.5",
    videoId: "video_1",
    taskId: "task_1",
    seconds: 8,
    size: "1080P",
    latencyMs: 42_000,
  } as never);
  agnesMock.createVideoTask.mockResolvedValue({ videoId: "video_1", taskId: "task_1", status: "queued" } as never);
  agnesMock.awaitVideoTask.mockResolvedValue({
    status: "completed",
    videoUrl: "https://cdn.example.com/clip.mp4",
    seconds: 8,
    lastProgress: 100,
  } as never);
  globalThis.fetch = vi.fn(async () => new Response(
    Buffer.from("fake-mp4-bytes"),
    { status: 200, headers: { "content-type": "video/mp4" } },
  )) as unknown as typeof fetch;
  assetServiceMock.registerAsset.mockResolvedValue({
    id: "vid-asset-1",
    kind: "video",
    role: sceneVideoRole("scene_001"),
    sceneId: "scene_001",
    media: { durationSec: 8 },
  } as never);
  walletMock.reserveFunds.mockResolvedValue({} as never);
  walletMock.settleReservation.mockResolvedValue({} as never);
  walletMock.releaseReservation.mockResolvedValue({} as never);
  agnesMock.isVideoGenerationEnabled.mockReturnValue(true);
  agnesMock.isVideoUnavailableError.mockReturnValue(false);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("buildSceneMotionPrompt — prompt cinéma structuré", () => {
  it("contient le sujet (visualPrompt), la caméra, le style pro et la cohérence", () => {
    const prompt = buildSceneMotionPrompt(makeProject(), makeScene());
    expect(prompt).toContain("savana at golden hour");
    expect(prompt).toContain("Camera:");
    expect(prompt).toContain("dolly in");
    expect(prompt).toContain("photorealistic cinematic footage");
    expect(prompt).toContain("preserve the exact appearance");
    expect(prompt).toContain("no text overlays");
  });

  it("traduit chaque preset de mouvement en langage caméra professionnel", () => {
    const project = makeProject();
    expect(buildSceneMotionPrompt(project, makeScene({ cameraMotion: "parallax" }))).toContain("parallax camera drift");
    expect(buildSceneMotionPrompt(project, makeScene({ cameraMotion: "dramatic_push" }))).toContain("dramatic dolly push-in");
    expect(buildSceneMotionPrompt(project, makeScene({ cameraMotion: "static" }))).toContain("locked-off static shot");
    expect(buildSceneMotionPrompt(project, makeScene({ cameraMotion: "tilt_up" }))).toContain("tilt-up reveal");
  });
});

describe("clipSecondsForScene — bornes API 4–12 s", () => {
  it("borne les durées de scène au palier générable", () => {
    expect(clipSecondsForScene(makeScene({ durationSec: 2 }))).toBe(4);
    expect(clipSecondsForScene(makeScene({ durationSec: 8 }))).toBe(8);
    expect(clipSecondsForScene(makeScene({ durationSec: 30 }))).toBe(12);
  });
});

describe("generateSceneVideo — cycle facturé clé en main", () => {
  it("réutilise un clip existant SANS nouvelle facturation (idempotence)", async () => {
    assetServiceMock.listAssets.mockResolvedValue([
      { id: "existing-clip", kind: "video", role: sceneVideoRole("scene_001"), sceneId: "scene_001", media: { durationSec: 8 } },
    ] as never);
    const result = await generateSceneVideo({ userId: "user-1", project: makeProject(), scene: makeScene() });
    expect(result.reused).toBe(true);
    expect(result.assetId).toBe("existing-clip");
    expect(walletMock.reserveFunds).not.toHaveBeenCalled();
    expect(agnesMock.generateVideo).not.toHaveBeenCalled();
  });

  it("réserve AVANT de générer, puis règle au réel (ordre escrow)", async () => {
    const order: string[] = [];
    walletMock.reserveFunds.mockImplementation(async () => { order.push("reserve"); return {}; });
    agnesMock.createVideoTask.mockImplementation(async () => { order.push("generate"); return { videoId: "v", taskId: "t", status: "queued" }; });
    walletMock.settleReservation.mockImplementation(async () => { order.push("settle"); return {}; });

    const result = await generateSceneVideo({ userId: "user-1", project: makeProject(), scene: makeScene() });
    expect(order).toEqual(["reserve", "generate", "settle"]);
    expect(result.generated).toBe(true);
    expect(result.clipSeconds).toBe(8);

    // Appel Agnes : mode keyframe avec l'image signée en première frame.
    const call = agnesMock.createVideoTask.mock.calls[0][0] as Record<string, unknown>;
    expect(call.mode).toBe("keyframe");
    expect(call.firstFrameUrl).toContain("https://r2.example.com/signed");
    expect(call.seconds).toBe(8);
    // Asset enregistré avec le rôle scene-video.
    const registered = assetServiceMock.registerAsset.mock.calls[0][0] as Record<string, unknown>;
    expect(registered.kind).toBe("video");
    expect(registered.role).toBe(sceneVideoRole("scene_001"));
    expect(registered.sceneId).toBe("scene_001");
    expect(registered.origin).toBe("generated");
  });

  it("échec fournisseur → libération INTÉGRALE de la réservation (rien débité) + erreur typée", async () => {
    agnesMock.isVideoUnavailableError.mockReturnValue(true);
    agnesMock.createVideoTask.mockRejectedValue(new Error("Agnes Video : HTTP 500"));

    await expect(
      generateSceneVideo({ userId: "user-1", project: makeProject(), scene: makeScene() }),
    ).rejects.toMatchObject({ name: "SceneVideoUnavailableError" });

    expect(walletMock.reserveFunds).toHaveBeenCalledTimes(1);
    expect(walletMock.releaseReservation).toHaveBeenCalledTimes(1);
    expect(walletMock.settleReservation).not.toHaveBeenCalled();
  });

  it("solde insuffisant → l'erreur du wallet remonte (402 à la route), AUCUNE génération", async () => {
    walletMock.reserveFunds.mockRejectedValue(new Error("Insufficient wallet balance for this execution."));
    await expect(
      generateSceneVideo({ userId: "user-1", project: makeProject(), scene: makeScene() }),
    ).rejects.toThrow(/Insufficient wallet balance/);
    expect(agnesMock.createVideoTask).not.toHaveBeenCalled();
    expect(walletMock.settleReservation).not.toHaveBeenCalled();
  });

  it("service désactivé → erreur d'indisponibilité immédiate (repli Ken Burns)", async () => {
    agnesMock.isVideoGenerationEnabled.mockReturnValue(false);
    await expect(
      generateSceneVideo({ userId: "user-1", project: makeProject(), scene: makeScene() }),
    ).rejects.toMatchObject({ name: "SceneVideoUnavailableError" });
  });

  it("génère l'image si elle manque (le clip a toujours une première frame cohérente)", async () => {
    imageBridgeMock.findSceneImage.mockResolvedValueOnce(null as never);
    const result = await generateSceneVideo({ userId: "user-1", project: makeProject(), scene: makeScene() });
    expect(imageBridgeMock.generateSceneImage).toHaveBeenCalledTimes(1);
    expect(result.generated).toBe(true);
  });
});

describe("startSceneVideoTask / awaitSceneVideoTask — reprise inter-ticks (jamais deux coûts)", () => {
  it("pending à l'échéance du tick → tâche CONSERVÉE, re-sondage SANS nouveau createVideoTask au tick suivant", async () => {
    const project = makeProject();
    const scene = makeScene();
    const image = makeImageAsset() as never;

    // TICK 1 : démarrage OK, sondage interrompu par l'échéance (pending).
    agnesMock.awaitVideoTask.mockResolvedValueOnce({ status: "pending", lastProgress: 42 } as never);
    const task = await startSceneVideoTask({ userId: "user-1", project, scene, image });
    expect(task.videoId).toBe("video_1");
    expect(task.billingReference).toBeTruthy();
    const tick1 = await awaitSceneVideoTask({ userId: "user-1", project, scene, task, deadlineMs: Date.now() + 1_000 });
    expect(tick1.status).toBe("pending");
    // La réservation n'est NI réglée NI libérée : l'escrow tient jusqu'à la terminaison.
    expect(walletMock.settleReservation).not.toHaveBeenCalled();
    expect(walletMock.releaseReservation).not.toHaveBeenCalled();

    // TICK 2 : RE-SONDAGE de la MÊME tâche (jamais de second createVideoTask).
    agnesMock.awaitVideoTask.mockResolvedValueOnce({ status: "completed", videoUrl: "https://cdn.example.com/clip.mp4", seconds: 8, lastProgress: 100 } as never);
    const tick2 = await awaitSceneVideoTask({ userId: "user-1", project, scene, task, deadlineMs: Date.now() + 1_000 });
    expect(tick2.status).toBe("completed");
    expect(agnesMock.createVideoTask).toHaveBeenCalledTimes(1); // UN SEUL coût fournisseur
    expect(agnesMock.awaitVideoTask).toHaveBeenCalledTimes(2); // deux sondages, une génération
    expect(walletMock.settleReservation).toHaveBeenCalledTimes(1); // règlement au réel à la complétion
  });

  it("échec définitif côté Agnes → libération INTÉGRALE (rien débité)", async () => {
    agnesMock.awaitVideoTask.mockResolvedValueOnce({ status: "failed", error: "Agnes Video : génération échouée — média invalide", lastProgress: 100 } as never);
    const project = makeProject();
    const scene = makeScene();
    const task = await startSceneVideoTask({ userId: "user-1", project, scene, image: makeImageAsset() as never });
    const outcome = await awaitSceneVideoTask({ userId: "user-1", project, scene, task });
    expect(outcome.status).toBe("failed");
    expect(walletMock.releaseReservation).toHaveBeenCalledTimes(1);
    expect(walletMock.settleReservation).not.toHaveBeenCalled();
  });

  it("clip déjà enregistré (crash entre register et checkpoint) → rattrapage du règlement, PAS de re-téléchargement", async () => {
    assetServiceMock.listAssets.mockResolvedValue([
      { id: "already-there", kind: "video", role: sceneVideoRole("scene_001"), sceneId: "scene_001", media: { durationSec: 8 } },
    ] as never);
    const project = makeProject();
    const scene = makeScene();
    const task = await startSceneVideoTask({ userId: "user-1", project, scene, image: makeImageAsset() as never });
    const outcome = await awaitSceneVideoTask({ userId: "user-1", project, scene, task });
    expect(outcome.status).toBe("completed");
    expect(agnesMock.awaitVideoTask).not.toHaveBeenCalled(); // pas même un sondage : l'asset est là
    expect(walletMock.settleReservation).toHaveBeenCalledTimes(1); // rattrapage du règlement
  });
});

describe("generateAllSceneVideos — lot parallèle résilient", () => {
  it("une scène en échec n'interrompt pas le lot (résultats par scène)", async () => {
    const project = makeProject();
    const scenes = [
      makeScene({ id: "scene_001", durationSec: 5 }),
      makeScene({ id: "scene_002", durationSec: 5 }),
      makeScene({ id: "scene_003", durationSec: 5 }),
    ];
    project.script = {
      hook: "h", introduction: "i", chapters: [], scenes,
      conclusion: "c", estimatedDurationSec: 15,
    } as never;

    // La scène 2 échoue (fonds insuffisants simulés côté réservation).
    walletMock.reserveFunds.mockImplementation((async (params: { metadata?: { sceneId?: string } }) => {
      if (params.metadata?.sceneId === "scene_002") throw new Error("Insufficient wallet balance for this execution.");
      return {};
    }) as never);

    const batch = await generateAllSceneVideos({ userId: "user-1", project });
    expect(batch.generated).toBe(2);
    expect(batch.failed).toBe(1);
    expect(batch.results.find((r) => r.sceneId === "scene_002")?.status).toBe("failed");
    expect(batch.results.find((r) => r.sceneId === "scene_001")?.status).toBe("generated");
    expect(batch.results.find((r) => r.sceneId === "scene_003")?.status).toBe("generated");
    // 2 clips facturés (chargeMinor > 0), la scène en échec n'a rien débité.
    expect(batch.results.filter((r) => (r.chargeMinor ?? 0) > 0).length).toBe(2);
  });
});

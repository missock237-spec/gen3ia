import { describe, it, expect } from "vitest";

/**
 * Tests réels : stockage vidéo (clés cloisonnées) + plan de rendu et
 * graphes FFmpeg (déterminisme, offsets xfade, mixage ducking).
 */

import { videoObjectKey, isOwnedVideoKey, videoProjectPrefix, VIDEO_STORAGE_DOMAINS } from "@/lib/video/storage";
import {
  buildRenderPlan,
  buildSegmentFfmpegArgs,
  buildTransitionFfmpegArgs,
  buildAudioMixFfmpegArgs,
  buildAssForRender,
  renderDimensions,
} from "@/lib/video/render/planner";
import type { RenderPlan, VideoProject, VideoTimeline, VideoAsset, SfxName, ScriptScene, MotionSpec } from "@/lib/video/types";

// ── Stockage ──────────────────────────────────────────────────────────────

describe("Stockage vidéo — clés cloisonnées (spec §25)", () => {
  it("layout users/{userId}/video/{projectId}/{domaine}/fichier", () => {
    const key = videoObjectKey({ userId: "u1", projectId: "p1", domain: "images", fileName: "img_001.png" });
    expect(key).toBe("users/u1/video/p1/images/img_001.png");
    expect(videoProjectPrefix("u1", "p1")).toBe("users/u1/video/p1/");
  });

  it("nom de fichier invalide refusé (injection/traversée)", () => {
    expect(() => videoObjectKey({ userId: "u1", projectId: "p1", domain: "images", fileName: "../escape.png" })).toThrow();
    expect(() => videoObjectKey({ userId: "u1", projectId: "p1", domain: "images", fileName: "a/b.png" })).toThrow();
  });

  it("isOwnedVideoKey : propriétaire OK, traversée et autres users refusés", () => {
    expect(isOwnedVideoKey("u1", "users/u1/video/p1/renders/master.mp4")).toBe(true);
    expect(isOwnedVideoKey("u1", "users/u2/video/p1/renders/master.mp4")).toBe(false);
    expect(isOwnedVideoKey("u1", "users/u1/video/p1/../secret")).toBe(false);
    expect(isOwnedVideoKey("u1", "")).toBe(false);
  });

  it("domaines couvrant la spécification (script..thumbnails)", () => {
    expect(VIDEO_STORAGE_DOMAINS).toEqual(expect.arrayContaining(["script", "storyboard", "images", "voice", "music", "sfx", "subtitles", "renders", "versions", "thumbnails"]));
  });
});

// ── Planner ───────────────────────────────────────────────────────────────

function fakeAsset(id: string, r2Key: string, kind: VideoAsset["kind"], sceneId?: string, durationSec?: number): VideoAsset {
  return {
    id, projectId: "p1", userId: "u1", kind, role: sceneId ? `scene:${sceneId}` : undefined,
    label: id, r2Key, contentType: kind === "image" ? "image/png" : "audio/wav",
    sizeBytes: 1000, origin: "generated", sceneId,
    media: durationSec ? { durationSec, hasAudio: true } : undefined,
    createdAt: new Date().toISOString(),
  };
}

function fakeProjectWithTimeline(): { project: VideoProject; timeline: VideoTimeline } {
  const scenes: ScriptScene[] = Array.from({ length: 3 }, (_, i) => ({
    id: `scene_00${i + 1}`,
    chapterId: "ch1",
    index: i,
    durationSec: 4,
    narration: `Narration ${i}`,
    visualPrompt: `scene ${i}`,
    visualType: "image" as const,
    cameraMotion: "slow_zoom" as const,
    transitionIn: i === 0 ? "fade" : "dissolve",
    transitionOut: "cut",
    soundEffects: (i === 0 ? ["impact"] : []) as SfxName[],
    captions: true,
    startSec: i * 4,
  }));
  const project = {
    id: "p1", userId: "u1", title: "T", description: "", language: "fr",
    aspectRatio: "16:9", resolution: "720p", fps: 25, targetDurationSec: 12,
    style: "documentaire", voicePreference: { kind: "auto" }, status: "storyboarded",
    visualBible: { styleDescriptors: "cinematic", palette: "", characters: [], locations: [] },
    script: { hook: "h", introduction: "i", chapters: [{ id: "ch1", title: "C1", summary: "", sceneIds: scenes.map((s) => s.id) }], scenes, conclusion: "c", estimatedDurationSec: 12 },
    storyboard: [], productionLog: [], versionCounter: 1,
    stats: { sceneCount: 3, assetCount: 0, renderedSeconds: 0, qcRounds: 0, billedMinor: 0 },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as unknown as VideoProject;

  const timeline: VideoTimeline = {
    version: 1, durationSec: 12, resolution: "720p", aspectRatio: "16:9", fps: 25,
    tracks: [
      { id: "t1", kind: "image", name: "Images", muted: false, clips: scenes.map((s) => ({ id: `clip_img_${s.id}`, startSec: s.startSec, durationSec: 4, layer: 0, transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1 }, motion: { preset: "slow_zoom", keyframes: [{ at: 0, scale: 1, x: 0, y: 0, rotationDeg: 0 }, { at: 1, scale: 1.12, x: 0, y: 0, rotationDeg: 0 }] }, effects: [], transitionIn: s.transitionIn === "cut" ? undefined : { name: s.transitionIn, durationSec: 0.5 } })) },
      { id: "t2", kind: "text", name: "Textes", muted: false, clips: [] },
      { id: "t3", kind: "voice", name: "Voix", muted: false, clips: [] },
      { id: "t4", kind: "music", name: "Musique", muted: false, clips: [] },
      { id: "t5", kind: "sfx", name: "SFX", muted: false, clips: [] },
    ],
    captions: { enabled: true, style: "documentary", position: "bottom" },
    musicBed: undefined,
    updatedAt: new Date().toISOString(),
  };
  return { project, timeline };
}

describe("Render Planner — plan déterministe", () => {
  it("segments = scènes avec image, transitions alignées, audio mix cohérent", () => {
    const { project, timeline } = fakeProjectWithTimeline();
    const imageByScene = new Map([
      ["scene_001", fakeAsset("a1", "users/u1/video/p1/images/1.png", "image", "scene_001")],
      ["scene_002", fakeAsset("a2", "users/u1/video/p1/images/2.png", "image", "scene_002")],
      ["scene_003", fakeAsset("a3", "users/u1/video/p1/images/3.png", "image", "scene_003")],
    ]);
    const narrationByScene = new Map([
      ["scene_001", fakeAsset("n1", "users/u1/video/p1/voice/1.mp3", "audio_narration", "scene_001", 3.8)],
    ]);
    const plan = buildRenderPlan({
      project, timeline, jobId: "job1",
      imageByScene, narrationByScene,
      sfxAssetByName: new Map([["impact", fakeAsset("s1", "users/u1/video/p1/sfx/impact.wav", "audio_sfx", undefined, 1.2)]]),
      musicBedAsset: fakeAsset("m1", "users/u1/video/p1/music/bed.wav", "audio_music", undefined, 30),
      derivedTargets: ["shorts_9_16"],
      assR2Key: "users/u1/video/p1/subtitles/sub.ass",
    });

    expect(plan.segments).toHaveLength(3);
    expect(plan.segments[0].imageR2Keys).toEqual(["users/u1/video/p1/images/1.png"]);
    expect(plan.transitions).toHaveLength(2);
    expect(plan.transitions[0]).toMatchObject({ afterSegmentIndex: 0, name: "dissolve" });
    expect(plan.audioMix.narration[0]?.assetId).toBe("n1");
    expect(plan.audioMix.ducking.enabled).toBe(true);
    expect(plan.subtitles?.assR2Key).toBe("users/u1/video/p1/subtitles/sub.ass");
    expect(plan.estimatedSec).toBe(12);
  });

  it("le même plan produit EXACTEMENT les mêmes arguments FFmpeg (déterminisme)", () => {
    const segment: RenderPlan["segments"][number] = {
      index: 0, sceneId: "scene_001", durationSec: 4,
      imageR2Keys: ["img.png"], motion: { preset: "slow_zoom", keyframes: [{ at: 0, scale: 1, x: 0, y: 0, rotationDeg: 0 }, { at: 1, scale: 1.12, x: 0, y: 0, rotationDeg: 0 }] },
      effects: [{ name: "vignette", intensity: "normal" }], textOverlays: [{ text: "Titre", style: "documentary", position: "bottom" }],
      transitionIn: "fade", transitionOut: "cut",
    };
    const ctx = { width: 1280, height: 720, fps: 25 };
    const args1 = buildSegmentFfmpegArgs({ segment, ctx, imageFiles: ["img.png"], outFile: "seg.mp4", fontFile: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf" });
    const args2 = buildSegmentFfmpegArgs({ segment, ctx, imageFiles: ["img.png"], outFile: "seg.mp4", fontFile: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf" });
    expect(args1).toEqual(args2);
    expect(args1.join(" ")).toContain("zoompan");
    expect(args1.join(" ")).toContain("vignette");
    expect(args1.join(" ")).toContain("drawtext");
    expect(args1.join(" ")).not.toContain(";"); // aucun séparateur suspect dans les args
  });

  it("transitions : offsets xfade exacts (Σ durées − Σ transitions)", () => {
    const built = buildTransitionFfmpegArgs({
      segmentFiles: ["s0.mp4", "s1.mp4", "s2.mp4"],
      durations: [4, 4, 4],
      transitions: [
        { afterSegmentIndex: 0, name: "dissolve", durationSec: 0.5 },
        { afterSegmentIndex: 1, name: "cut", durationSec: 0.04 },
      ],
      outFile: "out.mp4", fps: 25,
    });
    expect(built).not.toBeNull();
    const graph = built!.args[built!.args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("xfade=transition=dissolve:duration=0.500:offset=3.500");
    expect(graph).toContain("xfade=transition=fade:duration=0.040:offset=7.460");
    expect(built!.expectedDurationSec).toBeCloseTo(12 - 0.5 - 0.04, 2);
  });

  it("mixage audio : ducking sidechain + loudnorm + positions adelay", () => {
    const args = buildAudioMixFfmpegArgs({
      narrationFiles: [{ file: "n.wav", startSec: 2, volume: 1, fadeInSec: 0.1, fadeOutSec: 0.1 }],
      musicFile: "m.wav", musicVolume: 0.6,
      sfxFiles: [{ file: "s.wav", startSec: 0.5, volume: 0.8 }],
      ducking: { enabled: true, nominalVolume: 0.6, duckedVolume: 0.22, attackSec: 0.4, releaseSec: 0.8 },
      targetLoudnessDb: -16, durationSec: 12, outFile: "a.m4a",
    });
    expect(args).not.toBeNull();
    const graph = args![args!.indexOf("-filter_complex") + 1];
    expect(graph).toContain("adelay=2000|2000");   // narration à 2 s
    expect(graph).toContain("adelay=500|500");     // sfx à 0.5 s
    expect(graph).toContain("sidechaincompress");  // ducking RÉEL
    expect(graph).toContain("loudnorm=I=-16");     // normalisation cible
    expect(args).toContain("-t");
  });

  it("ASS de rendu généré seulement si captions activées", () => {
    const { project, timeline } = fakeProjectWithTimeline();
    expect(buildAssForRender(project, timeline, 1280, 720)).toBeTruthy();
    const noCaptions = { ...timeline, captions: { ...timeline.captions, enabled: false } };
    expect(buildAssForRender(project, noCaptions, 1280, 720)).toBeNull();
  });

  it("dimensions rendu : paires, ratio respecté", () => {
    const { project } = fakeProjectWithTimeline();
    const dims = renderDimensions(project);
    expect(dims.width % 2).toBe(0);
    expect(dims.height % 2).toBe(0);
    expect(dims.width / dims.height).toBeCloseTo(16 / 9, 2);
  });
});

// ── Motion interpolée → expression zoompan cohérente ──────────────────────

describe("Motion → graphe FFmpeg", () => {
  it("zoom croissant sur les frames (expression linéaire en 'on')", () => {
    const motion: MotionSpec = {
      preset: "slow_zoom",
      keyframes: [
        { at: 0, scale: 1, x: 0, y: 0, rotationDeg: 0 },
        { at: 1, scale: 1.12, x: 0, y: 0, rotationDeg: 0 },
      ],
    };
    const segment: RenderPlan["segments"][number] = {
      index: 0, sceneId: "s1", durationSec: 4, imageR2Keys: ["i.png"], motion,
      effects: [], textOverlays: [], transitionIn: "fade", transitionOut: "cut",
    };
    const args = buildSegmentFfmpegArgs({
      segment, ctx: { width: 1280, height: 720, fps: 25 }, imageFiles: ["i.png"], outFile: "seg.mp4",
    });
    const zExpr = args[args.indexOf("zoompan") - 0]; // présent dans -vf
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("zoompan");
    expect(vf).toMatch(/z='1\.0000\+\(0\.1200\)\*on\/100'/); // 4 s × 25 fps = 100 frames
    void zExpr;
  });
});

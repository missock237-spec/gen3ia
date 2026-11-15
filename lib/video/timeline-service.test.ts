import { describe, it, expect } from "vitest";

/**
 * Tests réels du Timeline Engine (module 12) : construction déterministe
 * depuis le scénario, opérations typées validées, bornes, recalcule durée.
 */

import {
  buildTimelineFromScript,
  applyTimelinePatch,
  validateTimeline,
  recomputeDuration,
  findClip,
  syncVoiceTrack,
} from "@/lib/video/timeline-service";
import type { VideoProject, VideoScript } from "@/lib/video/types";

function fakeProject(): VideoProject {
  const scenes = Array.from({ length: 3 }, (_, i) => ({
    id: `scene_00${i + 1}`,
    chapterId: "ch1",
    index: i,
    durationSec: 6,
    narration: `Narration ${i + 1}`,
    visualPrompt: `a scientist in a laboratory, cinematic light, scene ${i + 1}`,
    visualType: "image" as const,
    cameraMotion: "slow_zoom" as const,
    transitionIn: (i === 0 ? "fade" : "cut") as "fade" | "cut",
    transitionOut: "cut" as const,
    soundEffects: i === 0 ? (["whoosh"] as const) : ([] as never[]),
    captions: true,
    startSec: i * 6,
  }));
  return {
    id: "p1",
    userId: "u1",
    title: "Test",
    description: "",
    language: "fr",
    aspectRatio: "16:9",
    resolution: "1080p",
    fps: 30,
    targetDurationSec: 18,
    style: "documentaire",
    voicePreference: { kind: "auto" },
    status: "scripted",
    visualBible: { styleDescriptors: "", palette: "", characters: [], locations: [] },
    script: {
      hook: "Hook",
      introduction: "Intro",
      chapters: [{ id: "ch1", title: "Partie 1", summary: "", sceneIds: scenes.map((s) => s.id) }],
      scenes,
      conclusion: "Fin",
      estimatedDurationSec: 18,
    } satisfies VideoScript,
    storyboard: [],
    timeline: undefined,
    productionLog: [],
    versionCounter: 1,
    stats: { sceneCount: 3, assetCount: 0, renderedSeconds: 0, qcRounds: 0, billedMinor: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("buildTimelineFromScript", () => {
  it("crée un clip image par scène, positions exactes, durée totale correcte", () => {
    const timeline = buildTimelineFromScript(fakeProject(), { shortForm: false, captionsStyle: "documentary" });
    const imageTrack = timeline.tracks.find((t) => t.kind === "image")!;
    expect(imageTrack.clips).toHaveLength(3);
    expect(imageTrack.clips[0].startSec).toBe(0);
    expect(imageTrack.clips[1].startSec).toBe(6);
    expect(imageTrack.clips[2].startSec).toBe(12);
    expect(timeline.durationSec).toBe(18);
    expect(imageTrack.clips[0].motion?.preset).toBe("slow_zoom");
    expect(imageTrack.clips[0].motion?.keyframes.length).toBeGreaterThan(0);
  });

  it("pose les SFX du scénario sur la piste sfx et les textes sur la piste text", () => {
    const project = fakeProject();
    project.script!.scenes[1].onScreenText = "Chapitre 1";
    const timeline = buildTimelineFromScript(project, { shortForm: false, captionsStyle: "documentary" });
    expect(timeline.tracks.find((t) => t.kind === "sfx")!.clips).toHaveLength(1);
    expect(timeline.tracks.find((t) => t.kind === "text")!.clips).toHaveLength(1);
    expect(timeline.tracks.find((t) => t.kind === "text")!.clips[0].text).toBe("Chapitre 1");
  });

  it("mode shortForm : sous-titres shorts_bold centrés", () => {
    const timeline = buildTimelineFromScript(fakeProject(), { shortForm: true, captionsStyle: "documentary" });
    expect(timeline.captions.style).toBe("shorts_bold");
    expect(timeline.captions.position).toBe("center");
  });
});

describe("applyTimelinePatch", () => {
  it("resize_clip + move_clip appliqués et durées recalculées (chevauchement refusé)", () => {
    const timeline = buildTimelineFromScript(fakeProject(), { shortForm: false, captionsStyle: "documentary" });
    const imageTrack = timeline.tracks.find((t) => t.kind === "image")!;
    // Étendre le DERNIER clip (aucun clip suivant → pas de chevauchement).
    const lastClipId = imageTrack.clips[2].id;
    const next = applyTimelinePatch(timeline, "resize_clip", lastClipId, { durationSec: 10 });
    expect(findClip(next, lastClipId)!.clip.durationSec).toBe(10);
    expect(next.version).toBe(timeline.version + 1);
    const moved = applyTimelinePatch(next, "move_clip", lastClipId, { startSec: 14 });
    expect(findClip(moved, lastClipId)!.clip.startSec).toBe(14);
    expect(moved.durationSec).toBe(24); // 14 + 10
    // Étendre le premier clip jusqu'à chevaucher le second → VALIDATION refuse.
    expect(() => applyTimelinePatch(timeline, "resize_clip", imageTrack.clips[0].id, { durationSec: 10 })).toThrow(/chevauchement/i);
  });

  it("set_motion remplace les keyframes selon le preset", () => {
    const timeline = buildTimelineFromScript(fakeProject(), { shortForm: false, captionsStyle: "documentary" });
    const clipId = timeline.tracks.find((t) => t.kind === "image")!.clips[0].id;
    const next = applyTimelinePatch(timeline, "set_motion", clipId, { preset: "ken_burns" });
    expect(findClip(next, clipId)!.clip.motion?.preset).toBe("ken_burns");
  });

  it("set_transition cut supprime la transition", () => {
    const timeline = buildTimelineFromScript(fakeProject(), { shortForm: false, captionsStyle: "documentary" });
    const clipId = timeline.tracks.find((t) => t.kind === "image")!.clips[0].id;
    const next = applyTimelinePatch(timeline, "set_transition", clipId, { side: "in", name: "cut" });
    expect(findClip(next, clipId)!.clip.transitionIn).toBeUndefined();
  });

  it("set_transform borne les valeurs hors bornes", () => {
    const timeline = buildTimelineFromScript(fakeProject(), { shortForm: false, captionsStyle: "documentary" });
    const clipId = timeline.tracks.find((t) => t.kind === "image")!.clips[0].id;
    const next = applyTimelinePatch(timeline, "set_transform", clipId, { scale: 12, opacity: 3 });
    const clip = findClip(next, clipId)!.clip;
    expect(clip.transform.scale).toBe(4);
    expect(clip.transform.opacity).toBe(1);
  });

  it("échec propre : clip inconnu, durée invalide, volume hors bornes", () => {
    const timeline = buildTimelineFromScript(fakeProject(), { shortForm: false, captionsStyle: "documentary" });
    expect(() => applyTimelinePatch(timeline, "resize_clip", "clip_inconnu", { durationSec: 3 })).toThrow();
    expect(() => applyTimelinePatch(timeline, "resize_clip", "clip_img_scene_001", { durationSec: -1 })).toThrow();
    // Volume hors bornes : borné (pas de crash), la validation passe ensuite.
    const clamped = applyTimelinePatch(timeline, "set_clip_audio", "clip_img_scene_001", { volume: 9 });
    expect(findClip(clamped, "clip_img_scene_001")!.clip.audio?.volume).toBe(2);
  });
});

describe("validateTimeline / recomputeDuration / syncVoiceTrack", () => {
  it("détecte les chevauchements sur une piste image", () => {
    const timeline = buildTimelineFromScript(fakeProject(), { shortForm: false, captionsStyle: "documentary" });
    const imageTrack = timeline.tracks.find((t) => t.kind === "image")!;
    imageTrack.clips[1].startSec = 0; // chevauche le clip 0
    expect(() => validateTimeline(timeline)).toThrow(/chevauchement/i);
  });

  it("recomputeDuration aligne la durée sur le clip le plus lointain", () => {
    const timeline = buildTimelineFromScript(fakeProject(), { shortForm: false, captionsStyle: "documentary" });
    timeline.tracks.forEach((t) => (t.clips = t.clips.slice(0, 1)));
    expect(recomputeDuration(timeline)).toBe(6);
  });

  it("syncVoiceTrack crée les clips voix alignés sur les scènes", () => {
    const timeline = buildTimelineFromScript(fakeProject(), { shortForm: false, captionsStyle: "documentary" });
    const next = syncVoiceTrack(timeline, [
      { sceneId: "scene_001", assetId: "a1", startSec: 0, durationSec: 5.5 },
      { sceneId: "scene_002", assetId: "a2", startSec: 6, durationSec: 6 },
    ]);
    const voice = next.tracks.find((t) => t.kind === "voice")!;
    expect(voice.clips).toHaveLength(2);
    expect(voice.clips[0].assetId).toBe("a1");
    expect(voice.clips[0].startSec).toBe(0);
  });
});

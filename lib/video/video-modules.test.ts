import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Tests réels des sous-modules purs : Motion (keyframes + interpolation),
 * Effects (chaînes de filtres), transitions (xfade), Consistency Engine,
 * sous-titres (cues + ASS/SRT), sécurité (quotas), crédits (estimation),
 * révision (analyse déterministe), storyboard, chapitres Long Video.
 */

import { buildMotion, interpolateMotion } from "@/lib/video/motion-service";
import { buildEffectFilterChain, xfadeTransitionName, suggestTransition, defaultTransitionDurationSec } from "@/lib/video/effects-service";
import { buildVisualBibleFromScript, composeScenePrompt, bindReference } from "@/lib/video/consistency-engine";
import { buildCuesForScene, buildSubtitleTrack, toAssFile, toSrtFile } from "@/lib/video/subtitle-service";
import { groupConsecutiveMoods } from "@/lib/video/audio-engine";
import { assertDurationAllowed, assertResolutionAllowed, assertMediaSizeAllowed, assertMediaTypeAllowed, VideoQuotaError } from "@/lib/video/security";
import { estimateRenderCost } from "@/lib/video/credits";
import { parseIntentDeterministic } from "@/lib/video/revision-service";
import { buildStoryboard, sceneById } from "@/lib/video/script-service";
import { computeChapterWindows, describeChapters } from "@/lib/video/long-video-service";
import type { VideoProject, ScriptScene } from "@/lib/video/types";

// ── Motion Engine ─────────────────────────────────────────────────────────

describe("Motion Engine", () => {
  it("slow_zoom : zoom progressif 1.0 → 1.12 (spec)", () => {
    const motion = buildMotion("slow_zoom", 5);
    expect(motion.keyframes[0].scale).toBe(1.0);
    expect(motion.keyframes[motion.keyframes.length - 1].scale).toBeCloseTo(1.12, 2);
  });

  it("interpolation smoothstep entre keyframes (t=0.5 entre 1.0 et 1.12 ≈ 1.06)", () => {
    const motion = buildMotion("slow_zoom", 5);
    const mid = interpolateMotion(motion, 0.5);
    expect(mid.scale).toBeGreaterThan(1.0);
    expect(mid.scale).toBeLessThan(1.12);
  });

  it("t hors bornes → clamp aux keyframes extrêmes", () => {
    const motion = buildMotion("ken_burns", 4);
    expect(interpolateMotion(motion, -1).scale).toBe(motion.keyframes[0].scale);
    expect(interpolateMotion(motion, 2).scale).toBe(motion.keyframes[motion.keyframes.length - 1].scale);
  });

  it("tous les presets produisent des keyframes exploitables", () => {
    for (const preset of ["static", "slow_zoom", "zoom_out", "ken_burns", "pan_left_right", "pan_right_left", "tilt_up", "tilt_down", "parallax", "dramatic_push"] as const) {
      const motion = buildMotion(preset, 3);
      expect(motion.keyframes.length).toBeGreaterThanOrEqual(2);
      motion.keyframes.forEach((kf) => {
        expect(Number.isFinite(kf.scale)).toBe(true);
        expect(kf.at).toBeGreaterThanOrEqual(0);
        expect(kf.at).toBeLessThanOrEqual(1);
      });
    }
  });
});

// ── Effects + transitions ─────────────────────────────────────────────────

describe("Effects Engine", () => {
  it("chaîne de filtres réelle et déterministe", () => {
    const chain = buildEffectFilterChain([
      { name: "vignette", intensity: "normal" },
      { name: "grain", intensity: "subtle" },
      { name: "color_grade_cinematic", intensity: "normal" },
    ]);
    expect(chain).toContain("vignette");
    expect(chain).toContain("noise=alls=");
    expect(chain).toContain("colorbalance");
    const again = buildEffectFilterChain([{ name: "vignette", intensity: "normal" }, { name: "grain", intensity: "subtle" }, { name: "color_grade_cinematic", intensity: "normal" }]);
    expect(chain).toBe(again); // ordre stable = rendu déterministe
  });

  it("les transitions standard mappent sur des modes xfade natifs", () => {
    expect(xfadeTransitionName("dissolve")).toBe("dissolve");
    expect(xfadeTransitionName("wipe_left")).toBe("wipeleft");
    expect(xfadeTransitionName("flash")).toBe("fadewhite");
    expect(xfadeTransitionName("cut")).toBeNull();
    expect(xfadeTransitionName("glitch")).toBe("pixelize");
  });

  it("suggestion contextuelle : fondu aux extrémités, dissolve entre chapitres", () => {
    expect(suggestTransition({ chapterChange: false, isFirst: true, isLast: false, shortForm: false })).toBe("fade");
    expect(suggestTransition({ chapterChange: false, isFirst: false, isLast: true, shortForm: false })).toBe("fade");
    expect(suggestTransition({ chapterChange: true, isFirst: false, isLast: false, shortForm: false })).toBe("dissolve");
    expect(suggestTransition({ chapterChange: true, isFirst: false, isLast: false, shortForm: true })).toBe("slide_left");
  });

  it("durées par défaut bornées (0..2 s)", () => {
    for (const name of ["cut", "fade", "dissolve", "flash", "zoom", "blur"] as const) {
      const d = defaultTransitionDurationSec(name);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(2);
    }
  });
});

// ── Consistency Engine ────────────────────────────────────────────────────

function fakeScene(id: string, prompt: string, narration = "Une phrase de narration."): ScriptScene {
  return {
    id, chapterId: "ch1", index: 0, durationSec: 6, narration,
    visualPrompt: prompt, visualType: "image", cameraMotion: "slow_zoom",
    transitionIn: "fade", transitionOut: "cut", soundEffects: [], captions: true, startSec: 0,
  };
}

describe("Consistency Engine", () => {
  it("extrait les entités récurrentes en bible visuelle", () => {
    const scenes = [
      fakeScene("scene_001", "a scientist in a laboratory looking at a screen"),
      fakeScene("scene_002", "the scientist walks through the laboratory corridor"),
    ];
    const bible = buildVisualBibleFromScript({ chapters: [], scenes, hook: "", introduction: "", conclusion: "", estimatedDurationSec: 12 }, scenes);
    expect(bible.characters.some((c) => c.name.includes("scientist"))).toBe(true);
    expect(bible.locations.some((l) => l.name.includes("laboratory"))).toBe(true);
  });

  it("composeScenePrompt enrichit avec style global + fiches d'apparence + références", () => {
    const bible = buildVisualBibleFromScript({ chapters: [], scenes: [], hook: "", introduction: "", conclusion: "", estimatedDurationSec: 0 }, []);
    bible.characters.push({ id: "char_scientist", name: "scientist", appearancePrompt: "scientist with glasses, white coat", referenceAssetId: "asset_ref_1" });
    const project = {
      visualBible: bible,
      style: "documentaire cinématographique",
    } as unknown as VideoProject;
    const scene = fakeScene("scene_001", "the scientist explains, close up");
    const composed = composeScenePrompt(project, scene);
    expect(composed.prompt).toContain("the scientist explains");
    expect(composed.prompt).toContain("scientist with glasses");
    expect(composed.prompt).toContain("documentaire cinématographique");
    expect(composed.referenceEntityIds).toContain("char_scientist");
  });

  it("bindReference lie une image de référence à une entité", () => {
    const bible = buildVisualBibleFromScript({ chapters: [], scenes: [], hook: "", introduction: "", conclusion: "", estimatedDurationSec: 0 }, []);
    bible.characters.push({ id: "char_x", name: "explorer", appearancePrompt: "x" });
    const bound = bindReference(bible, "char_x", "asset_9");
    expect(bound.characters[0].referenceAssetId).toBe("asset_9");
  });
});

// ── Subtitle Engine ───────────────────────────────────────────────────────

describe("Subtitle Engine", () => {
  it("cues synchronisées : fenêtre de la scène, découpage par phrases", () => {
    const scene = fakeScene("scene_001", "x", "Première phrase de narration. Deuxième phrase un peu plus longue. Troisième phrase finale.");
    const cues = buildCuesForScene(scene);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    expect(cues[0].startSec).toBe(0);
    expect(cues[cues.length - 1].endSec).toBeCloseTo(scene.durationSec, 1);
    cues.forEach((cue) => {
      expect(cue.endSec).toBeGreaterThan(cue.startSec);
      expect(cue.text.split("\n").length).toBeLessThanOrEqual(2);
    });
  });

  it("scène sans narration ou captions désactivées → aucune cue", () => {
    const scene = fakeScene("scene_001", "x", "");
    expect(buildCuesForScene(scene)).toHaveLength(0);
    const muted = fakeScene("scene_002", "x", "Du texte.");
    muted.captions = false;
    expect(buildCuesForScene(muted)).toHaveLength(0);
  });

  it("ASS : en-tête valide, style, dialogues horodatés", () => {
    const track = buildSubtitleTrack([fakeScene("scene_001", "x", "Bonjour le monde. Deuxième ligne.")], "cinematic_yellow", "bottom");
    const ass = toAssFile(track, 1920, 1080);
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain("Style: Default");
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.\d+,/);
    expect(ass).toContain("Bonjour le monde");
  });

  it("SRT : séquence numérotée + timestamps standard", () => {
    const track = buildSubtitleTrack([fakeScene("scene_001", "x", "Deux phrases ici. Pour le test.")], "documentary", "bottom");
    const srt = toSrtFile(track);
    expect(srt).toMatch(/^1\n00:00:00,000 --> /);
    expect(srt).toContain("Deux phrases ici.");
  });

  it("style shorts_bold : gras centré (spec Shorts/TikTok)", () => {
    const track = buildSubtitleTrack([fakeScene("scene_001", "x", "Test.")], "shorts_bold", "center");
    const ass = toAssFile(track, 1080, 1920);
    expect(ass).toContain(",1,0,0,0,100,100,0,0,1,"); // Bold=1
    expect(ass).toContain(",5,"); // alignment centre
  });

  // Task 106-b — sous-titres ancrés sur la durée RÉELLE de la narration.
  it("Task 106-b : durée réelle plus courte → cues bornées à la voix (et non à la scène)", () => {
    const scene = fakeScene("scene_001", "x", "Première phrase de narration. Deuxième phrase un peu plus longue. Troisième phrase finale.");
    scene.durationSec = 6;
    const withoutReal = buildCuesForScene(scene);
    expect(withoutReal[withoutReal.length - 1].endSec).toBeCloseTo(6, 1); // historique

    const withReal = buildCuesForScene(scene, 3);
    expect(withReal.length).toBeGreaterThanOrEqual(2);
    expect(withReal[0].startSec).toBe(0);
    expect(withReal[withReal.length - 1].endSec).toBeCloseTo(3, 1); // ancré sur la voix
    withReal.forEach((cue) => {
      expect(cue.endSec).toBeGreaterThan(cue.startSec);
      expect(cue.endSec).toBeLessThanOrEqual(3.01);
    });
  });

  it("Task 106-b : durée réelle plus longue → plafonnée par la scène (inchangé)", () => {
    const scene = fakeScene("scene_001", "x", "Première phrase. Deuxième phrase.");
    scene.durationSec = 4;
    const capped = buildCuesForScene(scene, 99);
    expect(capped[capped.length - 1].endSec).toBeCloseTo(4, 1);
    // Sans le paramètre : strictement identique.
    const legacy = buildCuesForScene(scene);
    expect(capped).toEqual(legacy);
  });

  it("Task 106-b : fenêtre décalée (startSec > 0) + map de durées dans buildSubtitleTrack", () => {
    const scene = fakeScene("scene_002", "x", "Bonjour le monde. Deuxième ligne.");
    scene.startSec = 10;
    scene.durationSec = 4;
    const track = buildSubtitleTrack([scene], "documentary", "bottom", new Map([["scene_002", 2]]));
    expect(track.cues[0].startSec).toBe(10);
    expect(track.cues[track.cues.length - 1].endSec).toBeCloseTo(12, 1); // 10 + 2 s réels
  });

  it("Task 106-b : durée réelle invalide (0, NaN, négatif) → comportement historique", () => {
    const scene = fakeScene("scene_001", "x", "Première phrase. Deuxième phrase.");
    scene.durationSec = 4;
    const legacy = buildCuesForScene(scene);
    expect(buildCuesForScene(scene, 0)).toEqual(legacy);
    expect(buildCuesForScene(scene, Number.NaN)).toEqual(legacy);
    expect(buildCuesForScene(scene, -3)).toEqual(legacy);
  });
});

// ── Audio Engine — musique par scène (Task 106-b) ─────────────────────────

describe("Audio Engine — groupConsecutiveMoods (Task 106-b)", () => {
  function moodScene(id: string, startSec: number, durationSec: number, musicMood?: string): ScriptScene {
    return {
      id, chapterId: "ch1", index: 0, durationSec, narration: "n",
      visualPrompt: "v", visualType: "image", cameraMotion: "static",
      transitionIn: "fade", transitionOut: "cut", soundEffects: [], captions: false,
      startSec, ...(musicMood !== undefined ? { musicMood } : {}),
    };
  }

  it("3 moods consécutifs identiques → UN seul groupe étendu", () => {
    const groups = groupConsecutiveMoods([
      moodScene("s1", 0, 4, "tension"),
      moodScene("s2", 4, 4, "tension"),
      moodScene("s3", 8, 4, "tension"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ mood: "tension", startSec: 0, durationSec: 12 });
    expect(groups[0].sceneIds).toEqual(["s1", "s2", "s3"]);
  });

  it("moods alternés → 3 groupes distincts avec fenêtres exactes", () => {
    const groups = groupConsecutiveMoods([
      moodScene("s1", 0, 4, "tension"),
      moodScene("s2", 4, 4, "tension"),
      moodScene("s3", 8, 4, "energique"),
      moodScene("s4", 12, 4, "tension"),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ mood: "tension", startSec: 0, durationSec: 8 });
    expect(groups[1]).toMatchObject({ mood: "energique", startSec: 8, durationSec: 4 });
    expect(groups[2]).toMatchObject({ mood: "tension", startSec: 12, durationSec: 4 });
  });

  it("fallback : mood projet appliqué aux scènes sans musicMood", () => {
    const groups = groupConsecutiveMoods([
      moodScene("s1", 0, 4),
      moodScene("s2", 4, 4, "energique"),
      moodScene("s3", 8, 4),
    ], "emotionnel");
    // Sémantique CONSÉCUTIVE : s1 (fallback projet) / s2 / s3 (fallback
    // projet) = 3 fenêtres — s1 et s3 partagent le mood mais pas la
    // continuité temporelle (2 lits distincts posés aux fenêtres 0-4 et 8-12).
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ mood: "emotionnel", startSec: 0, durationSec: 4 });
    expect(groups[1]).toMatchObject({ mood: "energique", startSec: 4, durationSec: 4 });
    expect(groups[2]).toMatchObject({ mood: "emotionnel", startSec: 8, durationSec: 4 });
  });

  it("mood non reconnu → normalisé vers la valeur par défaut (documentaire)", () => {
    const groups = groupConsecutiveMoods([moodScene("s1", 0, 4, "mood inconnu xyz")]);
    expect(groups[0].mood).toBe("documentaire");
  });

  it("timeline vide → aucun groupe", () => {
    expect(groupConsecutiveMoods([])).toEqual([]);
  });
});

// ── Sécurité ──────────────────────────────────────────────────────────────

describe("Sécurité vidéo (quotas + validation)", () => {
  it("durée : accepte 10 s..3600 s, rejette au-delà et en dessous", () => {
    expect(() => assertDurationAllowed(600)).not.toThrow();
    expect(() => assertDurationAllowed(9)).toThrow(VideoQuotaError);
    expect(() => assertDurationAllowed(3601)).toThrow(VideoQuotaError);
    expect(() => assertDurationAllowed(Number.NaN)).toThrow();
  });

  it("résolution connue seulement", () => {
    expect(() => assertResolutionAllowed("1080p")).not.toThrow();
    expect(() => assertResolutionAllowed("8K")).toThrow();
  });

  it("taille : plafond 50 Mo pour les médias", () => {
    expect(() => assertMediaSizeAllowed(1024, "audio")).not.toThrow();
    expect(() => assertMediaSizeAllowed(51 * 1024 * 1024, "audio")).toThrow(/trop volumineux/i);
  });

  it("MIME : formats contrôlés", () => {
    expect(() => assertMediaTypeAllowed("audio", "audio/webm")).not.toThrow();
    expect(() => assertMediaTypeAllowed("audio", "application/x-msdownload")).toThrow();
    expect(() => assertMediaTypeAllowed("image", "image/png")).not.toThrow();
    expect(() => assertMediaTypeAllowed("image", "application/pdf")).toThrow();
  });
});

// ── Crédits ───────────────────────────────────────────────────────────────

describe("Crédits vidéo (coût par ressources, spec §29)", () => {
  it("estimation proportionnelle à la durée et pondérée par résolution", () => {
    const base = estimateRenderCost({ durationSec: 60, resolution: "1080p" });
    const longer = estimateRenderCost({ durationSec: 120, resolution: "1080p" });
    const uhd = estimateRenderCost({ durationSec: 60, resolution: "4K" });
    expect(longer.amountMinor).toBeGreaterThan(base.amountMinor);
    expect(uhd.amountMinor).toBeGreaterThan(base.amountMinor);
    expect(base.breakdown.length).toBeGreaterThan(0);
    expect(base.renderMinutes).toBeCloseTo(1, 1);
  });
});

// ── Révision conversationnelle (repli déterministe) ──────────────────────

describe("Révision — analyse déterministe", () => {
  it("détecte les commandes principales sans LLM", () => {
    expect(parseIntentDeterministic("La vidéo est trop rapide").intent).toBe("change_pace");
    expect(parseIntentDeterministic("Rends l'introduction plus cinématographique").intent).toBe("cinematic_intro");
    expect(parseIntentDeterministic("Fais une version TikTok").intent).toBe("shorts_version");
    expect(parseIntentDeterministic("Reviens à la version 2").intent).toBe("goto_version");
    expect(parseIntentDeterministic("Reviens à la version 2").versionNumber).toBe(2);
    expect(parseIntentDeterministic("Mets ma voix").intent).toBe("use_my_voice");
    expect(parseIntentDeterministic("Remplace la musique par quelque chose de tendu").intent).toBe("change_music");
    expect(parseIntentDeterministic("Ajoute des sous-titres jaunes").subtitleStyle).toBe("cinematic_yellow");
    expect(parseIntentDeterministic("Supprime la scène 12").intent).toBe("delete_scene");
    expect(parseIntentDeterministic("Supprime la scène 12").targetSceneId).toBe("scene_012");
    expect(parseIntentDeterministic("Bonjour").intent).toBe("unsupported");
  });
});

// ── Storyboard + chapitres Long Video ────────────────────────────────────

describe("Storyboard + Long Video Engine", () => {
  it("storyboard horodaté depuis le scénario", () => {
    const scenes = [
      fakeScene("scene_001", "a"),
      fakeScene("scene_002", "b"),
    ];
    scenes[1].startSec = 6;
    const project = { script: { chapters: [{ id: "ch1", title: "P1", summary: "", sceneIds: ["scene_001", "scene_002"] }], scenes, hook: "", introduction: "", conclusion: "", estimatedDurationSec: 12 }, timeline: undefined } as unknown as VideoProject;
    const storyboard = buildStoryboard(project.script!, scenes);
    expect(storyboard).toHaveLength(2);
    expect(storyboard[0].timecodeStartSec).toBe(0);
    expect(storyboard[1].timecodeStartSec).toBe(6);
    expect(storyboard[1].timecodeEndSec).toBe(12);
    expect(sceneById(project, "scene_002")?.id).toBe("scene_002");
  });

  it("fenêtres de chapitres pour une vidéo de 60 min", () => {
    const scenes = Array.from({ length: 12 }, (_, i) => ({
      ...fakeScene(`scene_${String(i + 1).padStart(3, "0")}`, "x"),
      startSec: i * 300,
      durationSec: 300,
      chapterId: i < 6 ? "ch1" : "ch2",
    }));
    const script = {
      chapters: [
        { id: "ch1", title: "Chapitre 1", summary: "", sceneIds: scenes.slice(0, 6).map((s) => s.id) },
        { id: "ch2", title: "Chapitre 2", summary: "", sceneIds: scenes.slice(6).map((s) => s.id) },
      ],
      scenes, hook: "", introduction: "", conclusion: "", estimatedDurationSec: 3600,
    };
    const windows = computeChapterWindows(script);
    expect(windows).toHaveLength(2);
    expect(windows[0].endSec).toBe(1800);
    expect(windows[1].startSec).toBe(1800);
    expect(windows[1].endSec).toBe(3600);
    const project = { script } as unknown as VideoProject;
    expect(describeChapters(project)).toContain("Chapitre 1 — 00:00 → 30:00");
    expect(describeChapters(project)).toContain("Chapitre 2 — 30:00 → 1:00:00");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Lot C4c (Task 101-c) — listVersions plafonné, sans snapshots (structurel)
// ────────────────────────────────────────────────────────────────────────────

describe("Lot C4c — historique des versions plafonné et sans snapshots", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const service = read("lib/video/project-service.ts");

  it("listVersions borne la requête Firestore à 20 versions (les plus récentes)", () => {
    expect(service).toContain("export const VERSIONS_LIST_LIMIT = 20;");
    expect(service).toMatch(/\.orderBy\("versionNumber", "desc"\)/);
    expect(service).toMatch(/\.limit\(VERSIONS_LIST_LIMIT\)/);
  });

  it("la requête n'extrait PAS les snapshots (champ select limité aux métadonnées)", () => {
    expect(service).toContain('.select("projectId", "versionNumber", "label", "createdBy", "note", "createdAt")');
    // Le repli défensif (couche résiliente) retire lui-même le snapshot.
    expect(service).toMatch(/snapshot: _snapshot, \.\.\.meta/);
  });


  it("la restauration relit les documents COMPLETS (snapshot disponible pour toute version)", () => {
    expect(service).toMatch(/restoreVersion[\s\S]*?resilientListByPayloadField<ProjectVersion>/);
  });
});

import { describe, it, expect } from "vitest";

/**
 * Task 106-b — montée en puissance du rendu : tests réels des nouvelles
 * capacités du planner / engine :
 *
 *   1. expressions zoompan interpolant TOUTES les keyframes (2/3/5 points)
 *      + compatibilité des presets motion historiques ;
 *   2. rotation réelle (filtre rotate, radians, ordre des filtres) ;
 *   3. transform des clips image (x/y/scale/opacity → scale/pad/crop/alpha) ;
 *   4. mixage multi-lits musicaux (musique par scène) + FIX narration
 *      perdue dans le sidechain ;
 *   5. timeout d'export résolu sur la durée RÉELLE du master.
 *
 * Tous les helpers testés sont PURES et déterministes (convention dépôt).
 */

import {
  buildRenderPlan,
  buildSegmentFfmpegArgs,
  buildAudioMixFfmpegArgs,
  buildZoompanExpression,
  buildRotateExpression,
  buildPiecewiseLinearExpr,
  rotationOverscanFactor,
  normalizeKeyframes,
  type SegmentFilterContext,
} from "@/lib/video/render/planner";
import {
  extractSegmentTransform,
  buildTransformFilters,
  isIdentityTransform,
  type SegmentTransform,
  type TransformableRenderSegment,
} from "@/lib/video/render/segment-transform";
import { resolveExportTimeoutSec } from "@/lib/video/render/engine";
import { buildMotion } from "@/lib/video/motion-service";
import type { MotionKeyframe, MotionPreset, RenderPlan, ScriptScene, SfxName, VideoAsset, VideoTimeline } from "@/lib/video/types";

// ── Fixtures ──────────────────────────────────────────────────────────────

const CTX: SegmentFilterContext = { width: 1280, height: 720, fps: 25 };

function kf(at: number, scale: number, x = 0, y = 0, rotationDeg = 0): MotionKeyframe {
  return { at, scale, x, y, rotationDeg };
}

function baseSegment(motion: RenderPlan["segments"][number]["motion"], transform?: SegmentTransform): TransformableRenderSegment {
  return {
    index: 0,
    sceneId: "scene_001",
    durationSec: 4,
    imageR2Keys: ["img.png"],
    motion,
    effects: [],
    textOverlays: [],
    transitionIn: "fade",
    transitionOut: "cut",
    ...(transform ? { transform } : {}),
  };
}

function vfOf(args: string[]): string {
  const i = args.indexOf("-vf");
  return i >= 0 ? args[i + 1] : "";
}

// ── 1. Expressions zoompan — toutes les keyframes ─────────────────────────

describe("Task 106-b — buildZoompanExpression (interpolation complète)", () => {
  it("2 keyframes couvrant la durée → formules linéaires compactes INCHANGÉES (zéro régression)", () => {
    const expr = buildZoompanExpression([kf(0, 1), kf(1, 1.12)], 100, { width: 1280, height: 720 });
    expect(expr.z).toBe("1.0000+(0.1200)*on/100");
    expect(expr.x).toBe("(iw-ow/zoom)/2+0.00*on/100");
    expect(expr.y).toBe("(ih-oh/zoom)/2+0.00*on/100");
  });

  it("2 keyframes avec pan → offsets en pixels identiques au format historique", () => {
    const expr = buildZoompanExpression([kf(0, 1.12, -0.06, 0.03), kf(1, 1.12, 0.05, -0.03)], 100, { width: 1280, height: 720 });
    expect(expr.x).toBe("(iw-ow/zoom)/2+70.40*on/100"); // (0.05+0.06)*1280/2
    expect(expr.y).toBe("(ih-oh/zoom)/2+-21.60*on/100"); // (-0.03-0.03)*720/2
  });

  it("3 keyframes → interpolation linéaire PAR MORCEAUX (if/clip), point intermédiaire atteint", () => {
    const expr = buildZoompanExpression([kf(0, 1), kf(0.5, 1.06), kf(1, 1.12)], 100, { width: 1280, height: 720 });
    expect(expr.z).toBe(
      "if(lte(on,50),1.0000+(0.0600)*clip(on,0,50)/50,1.0600+(0.0600)*(clip(on,50,100)-50)/50)",
    );
  });

  it("5 keyframes → 4 segments linéaires, if() imbriqués, chaque palier présent", () => {
    const expr = buildZoompanExpression(
      [kf(0, 1), kf(0.25, 1.03), kf(0.5, 1.06), kf(0.75, 1.09), kf(1, 1.12)],
      100,
      { width: 1280, height: 720 },
    );
    expect(expr.z).toContain("if(lte(on,25),");
    expect(expr.z).toContain("if(lte(on,50),");
    expect(expr.z).toContain("if(lte(on,75),");
    expect(expr.z).toContain("1.0000+(0.0300)*clip(on,0,25)/25");
    expect(expr.z).toContain("(clip(on,25,50)-25)/25");
    expect(expr.z).toContain("(clip(on,75,100)-75)/25");
    // Déterminisme : même entrée → même expression.
    const again = buildZoompanExpression([kf(0, 1), kf(0.25, 1.03), kf(0.5, 1.06), kf(0.75, 1.09), kf(1, 1.12)], 100, { width: 1280, height: 720 });
    expect(expr.z).toBe(again.z);
  });

  it("keyframes désordonnées / hors bornes → normalisées (tri + clamp at)", () => {
    const messy = [kf(1, 1.12), kf(0.5, 1.06), kf(-0.4, 0.98), kf(1.5, 1.2)];
    const expr = buildZoompanExpression(messy, 100, { width: 1280, height: 720 });
    const sorted = buildZoompanExpression([kf(0, 0.98), kf(0.5, 1.06), kf(1, 1.2)], 100, { width: 1280, height: 720 });
    expect(expr.z).toBe(sorted.z);
  });

  it("pan multi-keyframes : offset relatif à la PREMIÈRE keyframe (caméra part du centre)", () => {
    const expr = buildZoompanExpression([kf(0, 1.1, -0.08, 0), kf(0.5, 1.1, 0, 0), kf(1, 1.1, 0.08, 0)], 150, { width: 1280, height: 720 });
    // x relatif à x0=-0.08 : 0 → 0.08*1280/2 = 51.20 → 0.16*1280/2 = 102.40.
    // Format base+delta par segment (identique au zoom) : seg1 0→51.20,
    // seg2 51.20→102.40 (51.20 + 51.20×progress).
    expect(expr.x).toContain("0.00+(51.20)*clip(on,0,75)/75");
    expect(expr.x).toContain("51.20+(51.20)*(clip(on,75,150)-75)/75");
    expect(expr.x).toContain("if(lte(on,75)");
  });

  it("keyframes vides → expression identité sûre (z = 1)", () => {
    const expr = buildZoompanExpression([], 100, { width: 1280, height: 720 });
    expect(expr.z).toBe("1.0000+(0.0000)*on/100");
  });

  it("normalizeKeyframes écarte les valeurs non finies", () => {
    const normalized = normalizeKeyframes([
      { at: 0, scale: 1, x: 0, y: 0, rotationDeg: 0 },
      { at: Number.NaN, scale: 2, x: 0, y: 0, rotationDeg: 0 },
      { at: 1, scale: Number.NaN, x: 0, y: 0, rotationDeg: 0 },
    ]);
    expect(normalized).toHaveLength(1);
  });
});

describe("Task 106-b — buildPiecewiseLinearExpr (brique pure)", () => {
  it("valeur constante partout → expression constante", () => {
    expect(buildPiecewiseLinearExpr([{ frame: 0, value: 0.261799 }, { frame: 100, value: 0.261799 }], "n", 6)).toBe("0.261799");
  });

  it("point unique → palier ; vide → 0", () => {
    expect(buildPiecewiseLinearExpr([{ frame: 42, value: 1.5 }], "on", 4)).toBe("1.5000");
    expect(buildPiecewiseLinearExpr([], "on", 4)).toBe("0");
  });
});

// ── 2. Rotation ───────────────────────────────────────────────────────────

describe("Task 106-b — buildRotateExpression (rotation réelle)", () => {
  it("rotation nulle → null (aucun filtre rotate : zéro régression)", () => {
    expect(buildRotateExpression([kf(0, 1, 0, 0, 0), kf(1, 1.12, 0, 0, 0)], 100)).toBeNull();
  });

  it("rotation fixe 15° → radians corrects (15° = 0.261799 rad)", () => {
    expect(buildRotateExpression([kf(0, 1, 0, 0, 15), kf(1, 1, 0, 0, 15)], 100)).toBe("0.261799");
  });

  it("rotation interpolée (dramatic_push) → if()/clip() sur n, valeurs en radians", () => {
    const expr = buildRotateExpression([kf(0, 1, 0, 0, -0.4), kf(0.6, 1.1, 0, 0, 0.2), kf(1, 1.22, 0, 0, 0)], 100);
    expect(expr).toBe(
      "if(lte(n,60),-0.006981+(0.010472)*clip(n,0,60)/60,0.003491+(-0.003491)*(clip(n,60,100)-60)/40)",
    );
  });

  it("facteur d'overscan de rotation : 1 sans rotation, croissant avec l'angle, plafonné", () => {
    expect(rotationOverscanFactor(0, 1280, 720)).toBe(1);
    expect(rotationOverscanFactor(15, 1280, 720)).toBeCloseTo(Math.cos(Math.PI / 12) + (1280 / 720) * Math.sin(Math.PI / 12), 6);
    expect(rotationOverscanFactor(15, 1280, 720)).toBeGreaterThan(1);
    expect(rotationOverscanFactor(180, 1280, 720)).toBeLessThanOrEqual(1.5);
  });
});

describe("Task 106-b — rotation dans le graphe de filtres du segment", () => {
  it("segment sans rotation → aucun filtre rotate", () => {
    const args = buildSegmentFfmpegArgs({
      segment: baseSegment({ preset: "slow_zoom", keyframes: [kf(0, 1), kf(1, 1.12)] }),
      ctx: CTX,
      imageFiles: ["img.png"],
      outFile: "seg.mp4",
    });
    expect(vfOf(args)).not.toContain("rotate=");
  });

  it("segment avec rotation 15° → rotate présent, radians, AVANT crop et zoompan", () => {
    const args = buildSegmentFfmpegArgs({
      segment: baseSegment({ preset: "static", keyframes: [kf(0, 1, 0, 0, 15), kf(1, 1, 0, 0, 15)] }),
      ctx: CTX,
      imageFiles: ["img.png"],
      outFile: "seg.mp4",
    });
    const vf = vfOf(args);
    expect(vf).toContain("rotate=angle='0.261799':ow=iw:oh=ih");
    const iRotate = vf.indexOf("rotate=");
    const iCrop = vf.indexOf("crop=");
    const iZoompan = vf.indexOf("zoompan=");
    expect(iRotate).toBeGreaterThanOrEqual(0);
    expect(iRotate).toBeLessThan(iCrop); // rotation AVANT le crop final
    expect(iCrop).toBeLessThan(iZoompan); // puis fenêtre caméra
    // Pré-agrandissement couvrant l'angle (cos15 + (16/9)·sin15 × overscan).
    expect(vf).toContain(`scale=${Math.round(1664 * rotationOverscanFactor(15, 1280, 720))}:`);
  });

  it("compatibilité presets : les 10 presets produisent un graphe valide (rotation seulement si portée)", () => {
    const presets: MotionPreset[] = [
      "static", "slow_zoom", "zoom_out", "ken_burns", "pan_left_right",
      "pan_right_left", "tilt_up", "tilt_down", "parallax", "dramatic_push",
    ];
    for (const preset of presets) {
      const motion = buildMotion(preset, 4);
      const args = buildSegmentFfmpegArgs({ segment: baseSegment(motion), ctx: CTX, imageFiles: ["img.png"], outFile: "seg.mp4" });
      const vf = vfOf(args);
      expect(args).toContain("seg.mp4");
      expect(vf).toContain("zoompan=");
      expect(vf).not.toContain("NaN");
      expect(vf).not.toContain("undefined");
      const hasRotationKeyframe = motion.keyframes.some((k) => Math.abs(k.rotationDeg) > 1e-9);
      expect(vf.includes("rotate=")).toBe(hasRotationKeyframe); // dramatic_push seul
      if (motion.keyframes.length === 2) {
        // Presets 2 points → formules historiques préservées.
        expect(vf).toMatch(/z='[-0-9.]+\+\([-0-9.]+\)\*on\/100'/);
      } else {
        // Presets 3+ points → interpolation par morceaux.
        expect(vf).toContain("if(lte(on,");
      }
    }
  });
});

// ── 3. Transform des clips image ──────────────────────────────────────────

describe("Task 106-b — segment-transform (transform des clips rendus)", () => {
  function timelineWithTransform(transform: SegmentTransform | undefined, sceneId = "scene_001"): VideoTimeline {
    return {
      version: 1,
      durationSec: 12,
      resolution: "720p",
      aspectRatio: "16:9",
      fps: 25,
      tracks: [
        {
          id: "t1",
          kind: "image",
          name: "Images",
          muted: false,
          clips: [
            {
              id: `clip_img_${sceneId}`,
              startSec: 0,
              durationSec: 4,
              layer: 0,
              transform: {
                x: 0,
                y: 0,
                scale: 1,
                rotationDeg: 0,
                opacity: 1,
                ...(transform ?? {}),
              },
              effects: [],
            },
          ],
        },
      ],
      captions: { enabled: true, style: "documentary", position: "bottom" },
      updatedAt: new Date().toISOString(),
    };
  }

  it("isIdentityTransform : neutre/absent → true", () => {
    expect(isIdentityTransform(undefined)).toBe(true);
    expect(isIdentityTransform({})).toBe(true);
    expect(isIdentityTransform({ x: 0, y: 0, scale: 1, opacity: 1 })).toBe(true);
    expect(isIdentityTransform({ scale: 0.5 })).toBe(false);
    expect(isIdentityTransform({ opacity: 0.7 })).toBe(false);
  });

  it("extractSegmentTransform : clip absent ou neutre → undefined (comportement historique)", () => {
    expect(extractSegmentTransform(undefined, "scene_001")).toBeUndefined();
    expect(extractSegmentTransform(timelineWithTransform(undefined), "scene_001")).toBeUndefined();
    expect(extractSegmentTransform(timelineWithTransform({ scale: 0.5 }), "scene_999")).toBeUndefined();
  });

  it("extractSegmentTransform : transform non neutre extrait (x/y/scale/opacity)", () => {
    expect(extractSegmentTransform(timelineWithTransform({ scale: 0.5, y: 0.2, opacity: 0.8 }), "scene_001")).toEqual({
      x: 0,
      y: 0.2,
      scale: 0.5,
      opacity: 0.8,
    });
  });

  it("buildTransformFilters : scale < 1 → scale + pad sur canvas noir centré", () => {
    expect(buildTransformFilters({ scale: 0.5 }, { width: 1280, height: 720 })).toEqual([
      "scale=640:360",
      "pad=1280:720:320:180:black",
    ]);
  });

  it("buildTransformFilters : scale > 1 → scale + crop centré", () => {
    expect(buildTransformFilters({ scale: 2 }, { width: 1280, height: 720 })).toEqual([
      "scale=2560:1440",
      "crop=1280:720:640:360",
    ]);
  });

  it("buildTransformFilters : offsets seuls → pré-agrandissement suffisant + crop décalé", () => {
    expect(buildTransformFilters({ x: 0.1 }, { width: 1280, height: 720 })).toEqual([
      "scale=1536:864",
      "crop=1280:720:256:72",
    ]);
    expect(buildTransformFilters({ y: -0.25 }, { width: 1280, height: 720 })).toEqual([
      "scale=1920:1080",
      "crop=1280:720:320:0",
    ]);
  });

  it("buildTransformFilters : opacité < 1 → atténuation RGB + alpha (composite sur noir)", () => {
    expect(buildTransformFilters({ opacity: 0.5 }, { width: 1280, height: 720 })).toEqual([
      "format=rgba,colorchannelmixer=aa=0.500:rr=0.500:gg=0.500:bb=0.500",
    ]);
  });

  it("buildTransformFilters : absent/neutre → AUCUN filtre (zéro régression)", () => {
    expect(buildTransformFilters(undefined, { width: 1280, height: 720 })).toEqual([]);
    expect(buildTransformFilters({}, { width: 1280, height: 720 })).toEqual([]);
  });

  it("buildSegmentFfmpegArgs : transform présent → filtres APRÈS zoompan, AVANT effets/textes", () => {
    const args = buildSegmentFfmpegArgs({
      segment: baseSegment(
        { preset: "slow_zoom", keyframes: [kf(0, 1), kf(1, 1.12)] },
        { scale: 0.5, opacity: 0.8 },
      ),
      ctx: CTX,
      imageFiles: ["img.png"],
      outFile: "seg.mp4",
    });
    const vf = vfOf(args);
    const iZoompan = vf.indexOf("zoompan=");
    const iPad = vf.indexOf("pad=");
    const iAlpha = vf.indexOf("colorchannelmixer");
    expect(iPad).toBeGreaterThan(iZoompan);
    expect(iAlpha).toBeGreaterThan(iPad);
  });

  it("buildRenderPlan : le transform non neutre du clip accompagne le segment", () => {
    const scenes: ScriptScene[] = [
      {
        id: "scene_001", chapterId: "ch1", index: 0, durationSec: 4, narration: "a",
        visualPrompt: "a", visualType: "image", cameraMotion: "slow_zoom",
        transitionIn: "fade", transitionOut: "cut", soundEffects: [], captions: false, startSec: 0,
      },
      {
        id: "scene_002", chapterId: "ch1", index: 1, durationSec: 4, narration: "b",
        visualPrompt: "b", visualType: "image", cameraMotion: "static",
        transitionIn: "dissolve", transitionOut: "cut", soundEffects: [], captions: false, startSec: 4,
      },
    ];
    const project = {
      id: "p1", userId: "u1", title: "T", description: "", language: "fr",
      aspectRatio: "16:9", resolution: "720p", fps: 25, targetDurationSec: 8,
      style: "documentaire", voicePreference: { kind: "auto" }, status: "storyboarded",
      visualBible: { styleDescriptors: "", palette: "", characters: [], locations: [] },
      script: { hook: "", introduction: "", chapters: [], scenes, conclusion: "", estimatedDurationSec: 8 },
      storyboard: [], productionLog: [], versionCounter: 1,
      stats: { sceneCount: 2, assetCount: 0, renderedSeconds: 0, qcRounds: 0, billedMinor: 0 },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as unknown as Parameters<typeof buildRenderPlan>[0]["project"];

    const timeline = timelineWithTransform({ scale: 0.5 });
    (timeline.tracks[0].clips as Array<Record<string, unknown>>).push({
      id: "clip_img_scene_002",
      startSec: 4,
      durationSec: 4,
      layer: 0,
      transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1 },
      effects: [],
    });

    const image = (id: string, key: string): VideoAsset => ({
      id, projectId: "p1", userId: "u1", kind: "image", label: id, r2Key: key,
      contentType: "image/png", sizeBytes: 1, origin: "generated",
      createdAt: new Date().toISOString(),
    });
    const plan = buildRenderPlan({
      project,
      timeline,
      jobId: "job1",
      imageByScene: new Map([["scene_001", image("a1", "img1.png")], ["scene_002", image("a2", "img2.png")]]),
      narrationByScene: new Map(),
      sfxAssetByName: new Map<SfxName, VideoAsset>(),
      derivedTargets: [],
    });

    // RenderSegment (types.ts, hors périmètre) ne connaît pas encore le champ
    // — lecture via l'extension structurelle TransformableRenderSegment.
    const seg0 = plan.segments[0] as TransformableRenderSegment;
    const seg1 = plan.segments[1] as TransformableRenderSegment;
    expect(seg0.transform).toEqual({ x: 0, y: 0, scale: 0.5, opacity: 1 });
    expect(seg1.transform).toBeUndefined(); // neutre → champ absent
  });
});

// ── 4. Mixage multi-lits + FIX narration sidechain ────────────────────────

describe("Task 106-b — buildAudioMixFfmpegArgs (musique par scène + narration)", () => {
  const ducking = { enabled: true, nominalVolume: 0.6, duckedVolume: 0.22, attackSec: 0.4, releaseSec: 0.8 };

  it("lits multiples : chaque lit posé à sa fenêtre (atrim + fades + adelay), somme [musmix]", () => {
    const args = buildAudioMixFfmpegArgs({
      narrationFiles: [{ file: "n.wav", startSec: 0, volume: 1, fadeInSec: 0.1, fadeOutSec: 0.1 }],
      musicVolume: 0.6,
      musicFiles: [
        { file: "m1.wav", startSec: 0, durationSec: 8, volume: 0.6, fadeInSec: 1.5, fadeOutSec: 1 },
        { file: "m2.wav", startSec: 8, durationSec: 4, volume: 0.6, fadeInSec: 1, fadeOutSec: 2.5 },
      ],
      sfxFiles: [],
      ducking,
      targetLoudnessDb: -16,
      durationSec: 12,
      outFile: "a.m4a",
    });
    expect(args).not.toBeNull();
    const graph = args![args!.indexOf("-filter_complex") + 1];
    // Lit 1 : fondu in 1.5 s, out à 8−1 = 7 s.
    expect(graph).toContain("afade=t=in:d=1.500");
    expect(graph).toContain("afade=t=out:st=7.000:d=1.000");
    // Lit 2 : posé à 8 s, fondu out à 4−2.5 = 1.5 s.
    expect(graph).toContain("afade=t=in:d=1.000");
    expect(graph).toContain("afade=t=out:st=1.500:d=2.500");
    expect(graph).toContain("adelay=8000|8000");
    // Index global des entrées : narration [n0] (entrée 0), lits [m1] et [m2]
    // (entrées 1-2) — somme des lits puis ducking piloté par la narration.
    expect(graph).toContain("[m1][m2]amix=inputs=2:duration=longest:normalize=0[musmix]");
    expect(graph).toContain("[musmix][narrsc]sidechaincompress");
    // FIX : la narration EST dans le mix final.
    expect(graph).toContain("asplit=2[narrmain][narrsc]");
    expect(graph).toContain("[musduck][narrmain]amix=inputs=2");
    expect(graph).not.toMatch(/\[mus\]/); // chemin lit unique non utilisé
    expect(graph).toContain("loudnorm=I=-16");
  });

  it("FIX historique : lit unique + narration + ducking → la narration reste dans le mix (asplit)", () => {
    const args = buildAudioMixFfmpegArgs({
      narrationFiles: [{ file: "n.wav", startSec: 2, volume: 1, fadeInSec: 0.1, fadeOutSec: 0.1 }],
      musicFile: "m.wav",
      musicVolume: 0.6,
      sfxFiles: [],
      ducking,
      targetLoudnessDb: -16,
      durationSec: 12,
      outFile: "a.m4a",
    });
    const graph = args![args!.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[mus]");
    expect(graph).toContain("asplit=2[narrmain][narrsc]");
    expect(graph).toContain("[mus][narrsc]sidechaincompress");
    expect(graph).toContain("[musduck][narrmain]amix=inputs=2");
  });

  it("sans musique : comportement inchangé (narration + sfx, aucun asplit)", () => {
    const args = buildAudioMixFfmpegArgs({
      narrationFiles: [{ file: "n.wav", startSec: 0, volume: 1, fadeInSec: 0.1, fadeOutSec: 0.1 }],
      musicVolume: 0.6,
      sfxFiles: [{ file: "s.wav", startSec: 0.5, volume: 0.8 }],
      ducking,
      targetLoudnessDb: -16,
      durationSec: 12,
      outFile: "a.m4a",
    });
    const graph = args![args!.indexOf("-filter_complex") + 1];
    expect(graph).not.toContain("asplit");
    expect(graph).not.toContain("sidechaincompress");
    // Index global des entrées : narration [n0] (entrée 0), sfx [x1] (entrée 1).
    expect(graph).toContain("[n0][x1]amix=inputs=2");
  });

  it("musique seule (sans narration) : pas de ducking, aucun asplit", () => {
    const args = buildAudioMixFfmpegArgs({
      narrationFiles: [],
      musicVolume: 0.6,
      musicFiles: [{ file: "m1.wav", startSec: 0, durationSec: 8, volume: 0.6, fadeInSec: 1.5, fadeOutSec: 2.5 }],
      sfxFiles: [],
      ducking,
      targetLoudnessDb: -16,
      durationSec: 8,
      outFile: "a.m4a",
    });
    const graph = args![args!.indexOf("-filter_complex") + 1];
    expect(graph).not.toContain("asplit");
    expect(graph).not.toContain("sidechaincompress");
    expect(graph).toContain("afade=t=in:d=1.500");
  });
});

// ── 5. Timeout d'export sur la durée réelle ───────────────────────────────

describe("Task 106-b — resolveExportTimeoutSec (export timeout réel)", () => {
  it("priorité : paramètre appelant > probe ffprobe > repli historique 60 s", () => {
    expect(resolveExportTimeoutSec(120, 95.5)).toBe(120);
    expect(resolveExportTimeoutSec(undefined, 95.5)).toBe(95.5);
    expect(resolveExportTimeoutSec(undefined, undefined)).toBe(60);
  });

  it("valeurs invalides ignorées (NaN, 0, négatif)", () => {
    expect(resolveExportTimeoutSec(Number.NaN, 10)).toBe(10);
    expect(resolveExportTimeoutSec(0, 10)).toBe(10);
    expect(resolveExportTimeoutSec(-5, undefined)).toBe(60);
    expect(resolveExportTimeoutSec(undefined, 0)).toBe(60);
  });
});

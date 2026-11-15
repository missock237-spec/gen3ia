import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 119 — tests du moteur de SYNCHRONISATION VOIX-VISUEL (voice-sync) :
 * parsage astats RMS, fenêtres d'énergie, timeline (normalisation, silences,
 * pics), expressions FFmpeg déterministes (sinusoïdes par segments,
 * gaussiennes de punch), alignement des coupes sur les silences, détection
 * de personne, analyse réelle (I/O mockée : audio absent/court).
 */

vi.mock("@/lib/video/ffmpeg", () => ({
  runFfmpeg: vi.fn(),
}));

import {
  VOICE_MAX_PEAKS,
  amplitudeAt,
  analyzeNarrationAmplitude,
  alignSceneBoundariesToSilences,
  buildPunchZoomExpr,
  buildSinusoidalExpr,
  buildVoicePulseZoomExpr,
  buildVoiceSyncPlan,
  buildVoiceTimeline,
  bucketRmsWindows,
  parseAstatsRmsStdout,
  sampleAmplitudePoints,
  sceneHasSpeaker,
  type AmplitudeSample,
} from "./voice-sync";
import { runFfmpeg } from "@/lib/video/ffmpeg";

// ────────────────────────────────────────────────────────────────────────────
// 1. Parsage astats (pur)
// ────────────────────────────────────────────────────────────────────────────

describe("parseAstatsRmsStdout", () => {
  it("associe chaque pts_time au RMS_level qui le suit (paires ametadata)", () => {
    const stdout = [
      "frame:0    pts:0       pts_time:0",
      "lavfi.astats.Overall.RMS_level=-23.42",
      "frame:1    pts:512     pts_time:0.512",
      "lavfi.astats.Overall.RMS_level=-19.80",
    ].join("\n");
    const samples = parseAstatsRmsStdout(stdout);
    expect(samples).toEqual([
      { timeSec: 0, rmsDb: -23.42 },
      { timeSec: 0.512, rmsDb: -19.8 },
    ]);
  });

  it("-inf → plancher (silence, jamais NaN)", () => {
    const samples = parseAstatsRmsStdout("pts_time:1.2\nlavfi.astats.Overall.RMS_level=-inf");
    expect(samples).toEqual([{ timeSec: 1.2, rmsDb: -55 }]);
  });

  it("lignes inconnues et valeurs non finies écartées (tolérant)", () => {
    const stdout = "bruit\npts_time:abc\npts_time:2\nlavfi.astats.Overall.RMS_level=nan\npts_time:3\nlavfi.astats.Overall.RMS_level=-30";
    const samples = parseAstatsRmsStdout(stdout);
    expect(samples).toEqual([{ timeSec: 3, rmsDb: -30 }]);
  });

  it("sortie triée par temps même en désordre", () => {
    const samples = parseAstatsRmsStdout(
      ["pts_time:2.5", "lavfi.astats.Overall.RMS_level=-21", "pts_time:0.5", "lavfi.astats.Overall.RMS_level=-31"].join("\n"),
    );
    expect(samples.map((s) => s.timeSec)).toEqual([0.5, 2.5]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Fenêtres d'énergie (pur)
// ────────────────────────────────────────────────────────────────────────────

describe("bucketRmsWindows", () => {
  it("agrège les échantillons en fenêtres fixes ; vide → plancher", () => {
    const samples: AmplitudeSample[] = [
      { timeSec: 0.05, rmsDb: -20 },
      { timeSec: 0.1, rmsDb: -30 },
      { timeSec: 0.5, rmsDb: -25 },
    ];
    const windows = bucketRmsWindows(samples, 1, 0.2);
    expect(windows).toHaveLength(5);
    expect(windows[0].rmsDb).toBeCloseTo(-25, 5); // moyenne (-20, -30)
    expect(windows[1].rmsDb).toBe(-55); // vide → plancher
    expect(windows[2].rmsDb).toBe(-25);
  });

  it("échantillons hors durée ignorés, fenêtres régulières", () => {
    const windows = bucketRmsWindows([{ timeSec: 9.9, rmsDb: -40 }], 1, 0.25);
    expect(windows).toHaveLength(4);
    expect(windows[3].endSec).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Timeline : normalisation, silences, pics (pur)
// ────────────────────────────────────────────────────────────────────────────

describe("buildVoiceTimeline", () => {
  const loud = (start: number, end: number) => ({ startSec: start, endSec: end, rmsDb: -18 });
  const quiet = (start: number, end: number) => ({ startSec: start, endSec: end, rmsDb: -55 });

  it("normalisation 0..1 : plancher → 0, max réel → 1", () => {
    const timeline = buildVoiceTimeline([quiet(0, 0.2), loud(0.2, 0.4)]);
    expect(timeline.windows[0].normalized).toBe(0);
    expect(timeline.windows[1].normalized).toBe(1);
  });

  it("silences fusionnés en intervalles continus, trop courts filtrés", () => {
    const timeline = buildVoiceTimeline(
      [quiet(0, 0.1), quiet(0.1, 0.2), loud(0.2, 0.4), quiet(0.4, 0.44), loud(0.6, 0.8)],
      { minSilenceSec: 0.12 },
    );
    expect(timeline.silences).toEqual([{ startSec: 0, endSec: 0.2 }]);
  });

  it("pics : maxima locaux ≥ ratio du maximum, bornés à VOICE_MAX_PEAKS", () => {
    const windows = [
      { startSec: 0, endSec: 0.2, rmsDb: -50 },
      { startSec: 0.2, endSec: 0.4, rmsDb: -19 }, // pic 1 (0.95)
      { startSec: 0.4, endSec: 0.6, rmsDb: -24 },
      { startSec: 0.6, endSec: 0.8, rmsDb: -18 }, // pic 2 (1.0, max)
      { startSec: 0.8, endSec: 1.0, rmsDb: -26 },
      { startSec: 1.0, endSec: 1.2, rmsDb: -20 }, // pic 3 (0.9)
    ];
    const timeline = buildVoiceTimeline(windows, { peakRatio: 0.72 });
    expect(timeline.peakTimesSec).toEqual([0.3, 0.7, 1.1]);
    expect(timeline.peakTimesSec.length).toBeLessThanOrEqual(VOICE_MAX_PEAKS);
  });

  it("durée = fin de la dernière fenêtre", () => {
    const timeline = buildVoiceTimeline([quiet(0, 0.3), loud(0.3, 0.7)]);
    expect(timeline.durationSec).toBe(0.7);
  });
});

describe("amplitudeAt", () => {
  it("amplitude normalisée de la fenêtre courante ; hors bornes → 0", () => {
    const timeline = buildVoiceTimeline([
      { startSec: 0, endSec: 0.5, rmsDb: -18 },
      { startSec: 0.5, endSec: 1, rmsDb: -55 },
    ]);
    expect(amplitudeAt(timeline, 0.25)).toBe(1);
    expect(amplitudeAt(timeline, 0.75)).toBe(0);
    expect(amplitudeAt(timeline, 5)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Expressions FFmpeg déterministes (pur)
// ────────────────────────────────────────────────────────────────────────────

describe("buildSinusoidalExpr", () => {
  it("déterministe : mêmes points → EXACTEMENT la même expression", () => {
    const points = [
      { pos: 0, value: 0.1 },
      { pos: 30, value: 0.5 },
      { pos: 60, value: 0.2 },
    ];
    expect(buildSinusoidalExpr(points, "on")).toBe(buildSinusoidalExpr(points, "on"));
  });

  it("point unique / courbe plate → constante sans if()", () => {
    expect(buildSinusoidalExpr([{ pos: 0, value: 0.42 }], "t")).toBe("0.4200");
    expect(
      buildSinusoidalExpr(
        [
          { pos: 0, value: 0.3 },
          { pos: 10, value: 0.3 },
        ],
        "on",
      ),
    ).toBe("0.3000");
  });

  it("aucun point → 0", () => {
    expect(buildSinusoidalExpr([], "t")).toBe("0");
  });

  it("segments sinusoïdaux imbriqués par if(lte(var, borne))", () => {
    const expr = buildSinusoidalExpr(
      [
        { pos: 0, value: 0 },
        { pos: 15, value: 1 },
        { pos: 30, value: 0 },
      ],
      "on",
    );
    expect(expr).toContain("sin(");
    expect(expr).toContain("if(lte(on,15.0000)");
    // segment initial : distance clip(on,0,15) divisée par la portée 15 — le
    // clip SEUL (jamais une double division, la pente serait en 1/b²).
    expect(expr).toContain("(PI/2*(clip(on,0,15.0000))/15.0000)");
  });
});

describe("sampleAmplitudePoints", () => {
  it("points réguliers bornés, extrémités couvertes", () => {
    const timeline = buildVoiceTimeline([
      { startSec: 0, endSec: 0.5, rmsDb: -20 },
      { startSec: 0.5, endSec: 1.0, rmsDb: -50 },
      { startSec: 1.0, endSec: 1.5, rmsDb: -19 },
    ]);
    const points = sampleAmplitudePoints(timeline, 1.5, 0.5, 24);
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points.length).toBeLessThanOrEqual(24);
    expect(points[0].tSec).toBe(0);
    expect(points[points.length - 1].tSec).toBeCloseTo(1.5, 2);
    expect(points.every((p) => p.value >= 0 && p.value <= 1)).toBe(true);
  });
});

describe("buildVoicePulseZoomExpr (pouls caméra, amplitude → paramètres)", () => {
  const plan = buildVoiceSyncPlan(
    buildVoiceTimeline([
      { startSec: 0, endSec: 0.5, rmsDb: -18 },
      { startSec: 0.5, endSec: 1.0, rmsDb: -40 },
      { startSec: 1.0, endSec: 1.5, rmsDb: -17 },
    ]),
    1.5,
  );

  it("scène trop courte (< 0.8 s) → null (aucun pouls)", () => {
    expect(buildVoicePulseZoomExpr(plan, { fps: 30, durationSec: 0.5, amplitude: 0.012 })).toBeNull();
  });

  it("plan trop pauvre (< 2 points) → null", () => {
    expect(
      buildVoicePulseZoomExpr({ amplitude: [{ tSec: 0, value: 1 }], peakTimesSec: [] }, { fps: 30, durationSec: 5, amplitude: 0.01 }),
    ).toBeNull();
  });

  it("l'amplitude d'effet module le pouls (strong > subtle), positions en frames", () => {
    const subtle = buildVoicePulseZoomExpr(plan, { fps: 30, durationSec: 1.5, amplitude: 0.006 });
    const strong = buildVoicePulseZoomExpr(plan, { fps: 30, durationSec: 1.5, amplitude: 0.022 });
    expect(subtle).toBeTypeOf("string");
    expect(strong).toBeTypeOf("string");
    expect(strong).not.toBe(subtle);
    // positions converties en frames (tSec × fps)
    expect(strong).toContain("on");
  });
});

describe("buildPunchZoomExpr (gaussiennes sur pics)", () => {
  it("aucun pic → null", () => {
    expect(buildPunchZoomExpr([], { fps: 30, amplitude: 0.1 })).toBeNull();
  });

  it("un pic par gaussienne exp(-pow(on-c,2)/σ²) AVEC σ EN FRAMES, borné à maxPeaks", () => {
    const expr = buildPunchZoomExpr([0.5, 1.2], { fps: 30, amplitude: 0.11, widthSec: 0.22, maxPeaks: 1 });
    expect(expr).toBeTypeOf("string");
    expect(expr).toContain("exp(");
    expect(expr).toContain("pow(on-15.0,2)"); // 0.5 s × 30 fps = frame 15
    expect(expr).toContain("43.5600"); // σ = 0.22 s × 30 fps = 6.6 frames → σ² = 43.56
    // maxPeaks=1 : un seul terme (un seul exp)
    expect(expr.match(/exp\(/g)?.length).toBe(1);
  });

  it("amplitude négative bornée à 0 (jamais de dézoom)", () => {
    const expr = buildPunchZoomExpr([1], { fps: 25, amplitude: -3 });
    expect(expr).toContain("0.0000)*exp");
    expect(expr).not.toContain("-3.0000");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Coupes alignées sur les silences (pur)
// ────────────────────────────────────────────────────────────────────────────

describe("alignSceneBoundariesToSilences", () => {
  /** Timeline d'une scène : parole 0→1 s puis silence 1→2 s (fin de phrase). */
  const spokenThenSilent = buildVoiceTimeline([
    { startSec: 0, endSec: 0.25, rmsDb: -18 },
    { startSec: 0.25, endSec: 0.5, rmsDb: -18 },
    { startSec: 0.5, endSec: 0.75, rmsDb: -18 },
    { startSec: 0.75, endSec: 1.0, rmsDb: -18 },
    { startSec: 1.0, endSec: 1.25, rmsDb: -50 },
    { startSec: 1.25, endSec: 1.5, rmsDb: -50 },
    { startSec: 1.5, endSec: 1.75, rmsDb: -50 },
    { startSec: 1.75, endSec: 2.0, rmsDb: -50 },
  ]);

  it("frontière glissée au milieu du silence voisin, durée TOTALE inchangée", () => {
    const scenes = [
      { id: "s1", durationSec: 2 },
      { id: "s2", durationSec: 2 },
    ];
    const aligned = alignSceneBoundariesToSilences(scenes, new Map([["s1", spokenThenSilent]]));
    const total = aligned.reduce((n, s) => n + s.durationSec, 0);
    expect(total).toBeCloseTo(4, 2);
    // silence 1→2 s : frontière 2 reste 2 (déjà sur le silence) → inchangé
    expect(aligned[0].durationSec).toBe(2);
  });

  it("frontière glissée au MILIEU DU SILENCE le plus proche, durée TOTALE inchangée", () => {
    const scenes = [
      { id: "s1", durationSec: 1.4 }, // frontière 1.4 : le silence s'étend 1.0→2.0
      { id: "s2", durationSec: 2 },
    ];
    const aligned = alignSceneBoundariesToSilences(scenes, new Map([["s1", spokenThenSilent]]), { marginSec: 0.4, minShiftSec: 0.05 });
    const total = aligned.reduce((n, s) => n + s.durationSec, 0);
    expect(total).toBeCloseTo(3.4, 2);
    // milieu du silence = 1.5 (plus proche de 1.4 que la fin de parole 1.0)
    expect(aligned[0].durationSec).toBeCloseTo(1.5, 2);
    expect(aligned[1].startSec).toBeCloseTo(1.5, 2);
  });

  it("fin de phrase candidate quand le milieu du silence est hors marge", () => {
    const scenes = [
      { id: "s1", durationSec: 1.15 }, // frontière 1.15 : parole 0→1.0, silence 1.0→2.0 (milieu 1.5 hors marge)
      { id: "s2", durationSec: 2 },
    ];
    const aligned = alignSceneBoundariesToSilences(scenes, new Map([["s1", spokenThenSilent]]), { marginSec: 0.2, minShiftSec: 0.05 });
    const total = aligned.reduce((n, s) => n + s.durationSec, 0);
    expect(total).toBeCloseTo(3.15, 2);
    // seul candidat dans la marge : la fin de phrase à 1.0 → coupe avancée
    expect(aligned[0].durationSec).toBeCloseTo(1.0, 2);
    expect(aligned[1].durationSec).toBeCloseTo(2.15, 2);
  });

  it("aucune timeline → durées et positions inchangées", () => {
    const scenes = [
      { id: "s1", durationSec: 3 },
      { id: "s2", durationSec: 4 },
    ];
    const aligned = alignSceneBoundariesToSilences(scenes, new Map());
    expect(aligned.map((s) => s.durationSec)).toEqual([3, 4]);
    expect(aligned[1].startSec).toBe(3);
  });

  it("marge bornée : un silence hors marge ne déplace rien", () => {
    const scenes = [
      { id: "s1", durationSec: 2 },
      { id: "s2", durationSec: 2 },
    ];
    const aligned = alignSceneBoundariesToSilences(scenes, new Map([["s1", spokenThenSilent]]), { marginSec: 0.1 });
    expect(aligned[0].durationSec).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 6. Détection de personne (pur)
// ────────────────────────────────────────────────────────────────────────────

describe("sceneHasSpeaker", () => {
  it("subject explicite « person » → true ; sujet non humain → false", () => {
    expect(sceneHasSpeaker({ subject: "person", visualPrompt: "" })).toBe(true);
    expect(sceneHasSpeaker({ subject: "place", visualPrompt: "a woman in a kitchen" })).toBe(false);
  });

  it("repli heuristique sur le prompt visuel (portrait/orateur…)", () => {
    expect(sceneHasSpeaker({ visualPrompt: "close-up portrait of a chef plating a dish" })).toBe(true);
    expect(sceneHasSpeaker({ visualPrompt: "aerial view of the coastline at dawn" })).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 7. Analyse réelle (I/O mockée) — audio absent / court
// ────────────────────────────────────────────────────────────────────────────

describe("analyzeNarrationAmplitude", () => {
  beforeEach(() => {
    vi.mocked(runFfmpeg).mockReset();
  });

  it("audio ABSENT (ffmpeg échoue) → null, jamais bloquant", async () => {
    vi.mocked(runFfmpeg).mockRejectedValue(new Error("No such file"));
    const timeline = await analyzeNarrationAmplitude({ audioFile: "absent.mp3", cwd: "/tmp" });
    expect(timeline).toBeNull();
  });

  it("sortie sans échantillon (silence total / flux vide) → null", async () => {
    vi.mocked(runFfmpeg).mockResolvedValue({ stdout: "", stderr: "rien" } as never);
    const timeline = await analyzeNarrationAmplitude({ audioFile: "mute.mp3", cwd: "/tmp" });
    expect(timeline).toBeNull();
  });

  it("audio COURT (une poignée de trames) → timeline exploitable", async () => {
    const stderr = ["pts_time:0", "lavfi.astats.Overall.RMS_level=-20", "pts_time:0.3", "lavfi.astats.Overall.RMS_level=-45"].join("\n");
    vi.mocked(runFfmpeg).mockResolvedValue({ stdout: "", stderr } as never);
    const timeline = await analyzeNarrationAmplitude({ audioFile: "court.mp3", cwd: "/tmp", durationSec: 0.6 });
    expect(timeline).not.toBeNull();
    expect(timeline!.windows.length).toBeGreaterThan(0);
    expect(timeline!.windows.some((w) => w.normalized > 0)).toBe(true);
  });
});

describe("buildVoiceSyncPlan (plan sérialisable)", () => {
  it("points d'amplitude bornés + pics transmis", () => {
    const timeline = buildVoiceTimeline([
      { startSec: 0, endSec: 0.4, rmsDb: -18 },
      { startSec: 0.4, endSec: 0.8, rmsDb: -50 },
    ]);
    const plan = buildVoiceSyncPlan(timeline, 0.8);
    expect(plan.amplitude.length).toBeGreaterThanOrEqual(2);
    expect(plan.amplitude.every((p) => p.value >= 0 && p.value <= 1)).toBe(true);
    expect(Array.isArray(plan.peakTimesSec)).toBe(true);
  });
});

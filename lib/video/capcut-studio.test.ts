import { describe, expect, it } from "vitest";

/**
 * Task 119 — tests du studio vidéo « CapCut » : nouvelles RECETTES du
 * catalogue fermé (fragments FFmpeg valides), effets audio-réactifs
 * (voice_pulse / punch_zoom et leurs contextes), transitions xfade FFmpeg 6,
 * karaoké ASS (tags \k + \fad), QC CONTRAT UTILISATEUR, gardes du planner
 * (cinematic_flow ≤ 1080p, CRF adapté, concat stream copy).
 */

import {
  buildEffectFilterChain,
  defaultTransitionDurationSec,
  xfadeTransitionName,
  type EffectFragmentContext,
} from "@/lib/video/effects-service";
import {
  animatedEntryText,
  buildSubtitleTrack,
  karaokeTaggedText,
  toAssFile,
  type SubtitleCue,
} from "@/lib/video/subtitle-service";
import {
  USER_DURATION_TOLERANCE,
  detectUserContractIssues,
  hasUserContractViolation,
  parseBlackdetectStderr,
  parseSilencedetectStderr,
  parseVolumedetectStderr,
} from "@/lib/video/qc-service";
import { applyCinematicFlowGuard, crfForHeight, shouldConcatCopy } from "@/lib/video/render/planner";
import { EFFECT_NAMES, TRANSITION_NAMES, type RenderPlan, type ScriptScene } from "@/lib/video/types";

// ────────────────────────────────────────────────────────────────────────────
// Recettes du catalogue fermé (fragments valides)
// ────────────────────────────────────────────────────────────────────────────

const CTX: EffectFragmentContext = { width: 1920, height: 1080, fps: 30, durationSec: 5 };
const CTX24: EffectFragmentContext = { width: 1920, height: 1080, fps: 24, durationSec: 5 };

describe("Task 119 — recettes du catalogue (fragments FFmpeg valides)", () => {
  it("chaque effet du catalogue produit un fragment (ou un no-op honnête documenté)", () => {
    for (const name of EFFECT_NAMES) {
      // À 24 i/s et avec géométrie, TOUTES les recettes produisent un
      // fragment réel (cinematic_flow incluse : minterpolate sous 30 i/s).
      const chain = buildEffectFilterChain([{ name, intensity: "normal" }], CTX24);
      expect(chain.length).toBeGreaterThan(0);
      // Un fragment ne se termine JAMAIS par une virgule (chaîne cassée).
      expect(chain.endsWith(",")).toBe(false);
      expect(chain.startsWith(",")).toBe(false);
    }
  });

  it("sans contexte, les effets audio-réactifs sont des NO-OPS honnêtes (jamais de chaîne invalide)", () => {
    expect(buildEffectFilterChain([{ name: "voice_pulse", intensity: "normal" }])).toBe("");
    expect(buildEffectFilterChain([{ name: "punch_zoom", intensity: "normal" }])).toBe("");
    expect(buildEffectFilterChain([{ name: "parallax_depth", intensity: "normal" }])).toBe("");
  });

  it("voice_pulse : fragment de chaîne RETIRÉ quand le pouls est déjà au zoompan (pas de double application)", () => {
    const ctx: EffectFragmentContext = { ...CTX, voicePulseZoomExpr: "0.01*sin(on)" };
    expect(buildEffectFilterChain([{ name: "voice_pulse", intensity: "normal" }], ctx)).toBe("");
  });

  it("voice_pulse : oscillation de position MODULÉE par l'amplitude vocale (recette audio-réactive)", () => {
    const ctx: EffectFragmentContext = { ...CTX, voiceAmplitudeExpr: "0.5+0.3*sin(t)" };
    const chain = buildEffectFilterChain([{ name: "voice_pulse", intensity: "normal" }], ctx);
    expect(chain).toContain("crop=w=iw*0.94");
    expect(chain).toContain("sin(9*t)*(0.5+0.3*sin(t))");
    expect(chain.endsWith(`scale=${CTX.width}:${CTX.height}`)).toBe(true);
  });

  it("punch_zoom : zoompan avec gaussiennes des pics vocaux (variable on)", () => {
    const ctx: EffectFragmentContext = { ...CTX, voicePunchExpr: "0.11*exp(-(pow(on-90,2))/43.56)" };
    const chain = buildEffectFilterChain([{ name: "punch_zoom", intensity: "normal" }], ctx);
    expect(chain).toContain("zoompan=z='1+(0.11*exp(-(pow(on-90,2))/43.56))'");
    expect(chain).toContain(`s=${CTX.width}x${CTX.height}`);
  });

  it("glitch : rgbashift + bruit en rafales bornées (enable lt mod)", () => {
    const chain = buildEffectFilterChain([{ name: "glitch", intensity: "strong" }], CTX);
    expect(chain).toContain("rgbashift=");
    expect(chain).toContain("noise=alls=");
    expect(chain).toMatch(/enable='lt\(mod\(t,[\d.]+\),[\d.]+\)'/);
  });

  it("light_leak : balance chaude + vignette PULSANTE évaluée par frame", () => {
    const chain = buildEffectFilterChain([{ name: "light_leak", intensity: "normal" }], CTX);
    expect(chain).toContain("colorbalance=rs=");
    expect(chain).toContain("vignette=angle='PI/4.5+");
    expect(chain).toContain(":mode=forward:eval=frame");
  });

  it("parallax_depth : deux couches recadrées à vitesses différentes + blend", () => {
    const chain = buildEffectFilterChain([{ name: "parallax_depth", intensity: "normal" }], CTX);
    expect(chain).toContain("split[bgd][fgd]");
    expect(chain).toContain("boxblur=");
    expect(chain).toMatch(/\[bgp\]\[fgp\]blend=all_mode=normal:all_opacity=/);
  });

  it("gradings cinéma : teal_orange et bleach_bypass (curves/eq/colorbalance valides)", () => {
    const teal = buildEffectFilterChain([{ name: "teal_orange", intensity: "normal" }], CTX);
    expect(teal).toContain("colorbalance=rs=-");
    expect(teal).toContain("eq=saturation=");
    const bleach = buildEffectFilterChain([{ name: "bleach_bypass", intensity: "normal" }], CTX);
    expect(bleach).toContain("curves=all='0/");
    expect(bleach).toMatch(/eq=saturation=0\.\d+:contrast=/);
  });

  it("cinematic_flow : minterpolate 30fps SEULEMENT sous 30 i/s (no-op au-delà)", () => {
    expect(buildEffectFilterChain([{ name: "cinematic_flow", intensity: "normal" }], { ...CTX, fps: 24 })).toContain("minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:vsbmc=1");
    expect(buildEffectFilterChain([{ name: "cinematic_flow", intensity: "normal" }], { ...CTX, fps: 30 })).toBe("");
  });

  it("fragments vides (no-ops) écartés de la chaîne — jamais de virgule orpheline", () => {
    // Sans contexte : voice_pulse et cinematic_flow (≥ 30 i/s) sont des
    // no-ops — seule la vignette subsiste dans la chaîne.
    const chain = buildEffectFilterChain([
      { name: "voice_pulse", intensity: "normal" },
      { name: "vignette", intensity: "normal" },
      { name: "cinematic_flow", intensity: "normal" },
    ]);
    expect(chain).toBe(buildEffectFilterChain([{ name: "vignette", intensity: "normal" }]));
    expect(chain).not.toContain(",,");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Transitions xfade — modes natifs FFmpeg 6.0 uniquement
// ────────────────────────────────────────────────────────────────────────────

describe("Task 119 — transitions xfade FFmpeg 6 valides", () => {
  it("les nouvelles transitions mappent des modes xfade NATIFS 6.0 (jamais zoomin/hlwind)", () => {
    expect(xfadeTransitionName("smooth_left")).toBe("smoothleft");
    expect(xfadeTransitionName("circle_close")).toBe("circleclose");
    expect(xfadeTransitionName("sweep")).toBe("hlslice");
    expect(xfadeTransitionName("whip")).toBe("squeezev");
    expect(xfadeTransitionName("blur_dissolve")).toBe("hblur");
    expect(xfadeTransitionName("radial_wipe")).toBe("radial");
    // Les modes FFmpeg 7.x n'existent nulle part dans la map.
    const allNames = TRANSITION_NAMES.map((n) => xfadeTransitionName(n)).filter((v): v is string => v !== null);
    expect(allNames).not.toContain("zoomin");
    expect(allNames).not.toContain("hlwind");
    expect(allNames).not.toContain("hrwind");
  });

  it("durées par défaut : whip vif (0.25 s), radial_wipe ample (0.6 s)", () => {
    expect(defaultTransitionDurationSec("whip")).toBe(0.25);
    expect(defaultTransitionDurationSec("sweep")).toBe(0.45);
    expect(defaultTransitionDurationSec("smooth_left")).toBe(0.5);
    expect(defaultTransitionDurationSec("circle_close")).toBe(0.6);
    expect(defaultTransitionDurationSec("blur_dissolve")).toBe(0.6);
    expect(defaultTransitionDurationSec("radial_wipe")).toBe(0.6);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Karaoké ASS (tags \k mot à mot) + entrées animées
// ────────────────────────────────────────────────────────────────────────────

function cue(text: string, startSec = 0, endSec = 2): SubtitleCue {
  return { startSec, endSec, text };
}

describe("Task 119 — karaoké ASS (\\k) + entrées animées", () => {
  it("chaque mot porte un tag \\k (centisecondes), durée répartie au prorata", () => {
    const tagged = karaokeTaggedText(cue("Bonjour le monde", 0, 2));
    expect(tagged).toContain("{\\fad(120,60)}");
    const words = tagged.slice(tagged.indexOf("}") + 1).split(" ");
    expect(words).toEqual(["{\\k93}Bonjour", "{\\k40}le", "{\\k67}monde"]);
    // Poids 7/3/5 sur 200 cs (durée exacte de la cue) — le dernier mot
    // absorbe l'arrondi (66 → 67).
    const ks = [...tagged.matchAll(/\{\\k(\d+)\}/g)].map((m) => Number(m[1]));
    expect(ks.reduce((a, b) => a + b, 0)).toBe(200);
    expect(ks.every((k) => k >= 4)).toBe(true); // jamais illisible (< 40 ms)
  });

  it("durées karaoké SOMMÉES = durée EXACTE de la cue (correction d'arrondi sur le dernier mot)", () => {
    const tagged = karaokeTaggedText(cue("Une phrase suffisamment longue pour durer", 0, 3.2));
    const ks = [...tagged.matchAll(/\{\\k(\d+)\}/g)].map((m) => Number(m[1]));
    expect(ks.reduce((a, b) => a + b, 0)).toBe(320);
  });

  it("cue multi-lignes : \\N conservé, mots des DEUX lignes tagués", () => {
    const tagged = karaokeTaggedText(cue("Première ligne\nDeuxième ligne", 0, 2));
    expect(tagged).toContain("\\N");
    expect([...tagged.matchAll(/\{\\k\d+\}/g)].length).toBe(4);
  });

  it("animatedEntryText : pop d'échelle 92→100 % + fondu pour shorts_bold", () => {
    const text = animatedEntryText(cue("POW !", 0, 1), true);
    expect(text).toContain("{\\fad(120,60)\\fscx92\\fscy92\\t(0,140,\\fscx100\\fscy100)}POW !");
  });

  it("animatedEntryText sans pop : fondu seul", () => {
    expect(animatedEntryText(cue("Ligne", 0, 1), false)).toBe("{\\fad(120,60)}Ligne");
  });

  it("toAssFile style karaoke_pop : couleur de PRÉ-REMPLISSAGE secondaire + tags \\k dans les événements", () => {
    const track = buildSubtitleTrack([sceneWithNarration("Karaoké mot à mot sur cette scène.")], "karaoke_pop", "center");
    const ass = toAssFile(track, 1080, 1920);
    // SecondaryColour = surlignage vif (avant que le \k ne « remplisse » le mot)
    expect(ass).toContain("&H0000E5FF");
    expect(ass).toContain("{\\k");
    expect(ass).toContain("{\\fad(120,60)}");
  });

  it("toAssFile style shorts_bold : entrée animée \\t (pop) appliquée", () => {
    const track = buildSubtitleTrack([sceneWithNarration("Court et percutant.")], "shorts_bold", "center");
    const ass = toAssFile(track, 1080, 1920);
    expect(ass).toContain("\\fscx92\\fscy92\\t(0,140,\\fscx100\\fscy100)");
  });

  it("styles documentaires : STRICTEMENT inchangés (aucun tag dynamique)", () => {
    for (const style of ["documentary", "minimal", "cinematic_yellow"] as const) {
      const track = buildSubtitleTrack([sceneWithNarration("Une narration classique sur plusieurs mots.")], style, "bottom");
      const ass = toAssFile(track, 1920, 1080);
      expect(ass).not.toContain("\\k");
      expect(ass).not.toContain("\\fscx");
      expect(ass).not.toContain("\\fad");
    }
  });
});

/** Scène narrée minimale (mêmes champs que les tests subtitle existants). */
function sceneWithNarration(narration: string): ScriptScene {
  return {
    id: "scene_001",
    chapterId: "ch1",
    index: 0,
    durationSec: 4,
    narration,
    visualPrompt: "v",
    visualType: "image",
    cameraMotion: "static",
    transitionIn: "fade",
    transitionOut: "cut",
    soundEffects: [],
    captions: true,
    startSec: 0,
  } as ScriptScene;
}

// ────────────────────────────────────────────────────────────────────────────
// QC CONTRAT UTILISATEUR (Task 119)
// ────────────────────────────────────────────────────────────────────────────

describe("Task 119 — QC contrat utilisateur (durée ±10 %, ratio, sous-titres, narration)", () => {
  it("durée rendue dans la tolérance ±10 % → aucune issue", () => {
    const issues = detectUserContractIssues(
      { targetDurationSec: 30 },
      { durationSec: 28.5, subtitlesBurned: false },
    );
    expect(issues).toEqual([]);
  });

  it("durée hors tolérance → issue CRITIQUE actionnable (trop courte/courte dite)", () => {
    const issues = detectUserContractIssues(
      { targetDurationSec: 30 },
      { durationSec: 20, subtitlesBurned: false },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("duration_mismatch");
    expect(issues[0].severity).toBe("critical");
    expect(issues[0].detail).toContain("trop courte");
    expect(issues[0].detail).toContain("10 % tolérés");
    expect(issues[0].detail).toContain("33.3 %");
    expect(USER_DURATION_TOLERANCE).toBe(0.1);
  });

  it("ratio demandé vs rendu → issue aspect_ratio_mismatch (±3 %)", () => {
    const ok = detectUserContractIssues(
      { aspectRatio: "9:16" },
      { width: 1080, height: 1920, subtitlesBurned: true },
    );
    expect(ok).toEqual([]);
    const bad = detectUserContractIssues(
      { aspectRatio: "9:16" },
      { width: 1920, height: 1080, subtitlesBurned: true },
    );
    expect(bad).toHaveLength(1);
    expect(bad[0].kind).toBe("aspect_ratio_mismatch");
    expect(bad[0].severity).toBe("critical");
  });

  it("sous-titres demandés mais non brûlés → captions_missing avec suggestedFix", () => {
    const issues = detectUserContractIssues({ captionsRequired: true }, { subtitlesBurned: false });
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("captions_missing");
    expect(issues[0].suggestedFix).toEqual({ type: "reburn_subtitles" });
  });

  it("narration demandée mais AUCUN flux audio → narration_missing avec suggestedFix", () => {
    const issues = detectUserContractIssues({ narrationRequired: true }, { hasAudioStream: false, subtitlesBurned: true });
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("narration_missing");
    expect(issues[0].suggestedFix).toEqual({ type: "rebuild_audio" });
  });

  it("hasUserContractViolation : SEULEMENT les issues critiques du contrat font échouer la QC", () => {
    expect(
      hasUserContractViolation({
        passed: false,
        issues: [{ kind: "captions_missing", severity: "critical", detail: "x" }],
      }),
    ).toBe(true);
    expect(
      hasUserContractViolation({
        passed: false,
        issues: [{ kind: "captions_missing", severity: "warning", detail: "x" }],
      }),
    ).toBe(false);
    expect(
      hasUserContractViolation({
        passed: false,
        issues: [{ kind: "volume_inconsistent", severity: "critical", detail: "x" }],
      }),
    ).toBe(false);
  });

  it("parseurs UNE PASSE (volumedetect + silencedetect + blackdetect)", () => {
    expect(parseVolumedetectStderr("max_volume: -0.2 dB\nmean_volume: -18.4 dB")).toEqual({ maxVolumeDb: -0.2, meanVolumeDb: -18.4 });
    expect(parseVolumedetectStderr("rien")).toBeNull();
    expect(
      parseSilencedetectStderr("silence_start: 1.0\nsilence_end: 3.5\nsilence_start: 10\nsilence_end: 12"),
    ).toEqual({ totalSec: 4.5 });
    expect(parseBlackdetectStderr("black_start: 0.5 black_end: 1.5\nblack_start: 8 black_end: 8.2")).toEqual({ totalSec: 1.2 });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Gardes du planner (Task 119/120)
// ────────────────────────────────────────────────────────────────────────────

describe("Task 119/120 — gardes planner : cinematic_flow, CRF, concat stream copy", () => {
  it("cinematic_flow AUTO sous 1080p/<30 i/s, RETIRÉE au-delà de 1080p (jamais demandée)", () => {
    const added = applyCinematicFlowGuard([], "1080p", 24);
    expect(added).toEqual([{ name: "cinematic_flow", intensity: "normal" }]);
    const kept = applyCinematicFlowGuard([], "1080p", 30);
    expect(kept).toEqual([]);
    const stripped = applyCinematicFlowGuard([{ name: "cinematic_flow", intensity: "normal" }], "4K", 24);
    expect(stripped).toEqual([]);
  });

  it("CRF adapté à la hauteur : 480p→24, 720p→23, 1080p→21, 1440p/4K→20", () => {
    expect(crfForHeight(480)).toBe(24);
    expect(crfForHeight(720)).toBe(23);
    expect(crfForHeight(1080)).toBe(21);
    expect(crfForHeight(1440)).toBe(20);
    expect(crfForHeight(2160)).toBe(20);
    expect(crfForHeight(0)).toBe(21); // invalide → défaut historique
  });

  it("shouldConcatCopy : uniquement des coupes franches → stream copy", () => {
    const plan = (names: string[]) => ({ transitions: names.map((name) => ({ name, durationSec: 0.4 })) }) as unknown as RenderPlan;
    expect(shouldConcatCopy(plan([]).transitions, 3)).toBe(true);
    expect(shouldConcatCopy(plan(["cut", "cut"]).transitions, 3)).toBe(true);
    expect(shouldConcatCopy(plan(["cut", "fade"]).transitions, 3)).toBe(false);
    expect(shouldConcatCopy(plan(["smooth_left"]).transitions, 3)).toBe(false);
    expect(shouldConcatCopy(plan(["cut", "glitch"]).transitions, 3)).toBe(false); // glitch = pixelize (xfade)
    expect(shouldConcatCopy(plan(["cut"]).transitions, 1)).toBe(false); // un seul segment : pas d'assemblage
  });
});

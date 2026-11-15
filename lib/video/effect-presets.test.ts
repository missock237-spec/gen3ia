import { describe, expect, it } from "vitest";

import {
  mergePresetEffects,
  parseEffectPreset,
  PRESET_MOTION,
  presetIntensityLabel,
  effectPresetFromText,
} from "./effect-presets";

describe("Task 134 — presets d'effets d'animation vidéo", () => {
  it("parseEffectPreset valide les valeurs du catalogue fermé", () => {
    expect(parseEffectPreset("capcut")).toBe("capcut");
    expect(parseEffectPreset("cinematic")).toBe("cinematic");
    expect(parseEffectPreset(" dynamic ")).toBe("dynamic");
    expect(parseEffectPreset("none")).toBe("none");
    expect(parseEffectPreset("subtle")).toBe("subtle");
  });

  it("parseEffectPreset rejette les valeurs inconnues (garde anti-LLM)", () => {
    expect(parseEffectPreset("explosif")).toBeNull();
    expect(parseEffectPreset("")).toBeNull();
    expect(parseEffectPreset(undefined)).toBeNull();
    expect(parseEffectPreset(42)).toBeNull();
    expect(parseEffectPreset("CAPCUT")).toBe("capcut"); // insensible à la casse
  });

  it("mergePresetEffects n'ajoute QUE les effets du preset, sans doublon", () => {
    const existing = [{ name: "vignette", intensity: "normal" as const }];
    const merged = mergePresetEffects(existing, "subtle");
    // vignette déjà présente → pas de doublon ; grain ajouté
    expect(merged).toHaveLength(2);
    expect(merged.filter((e) => e.name === "vignette")).toHaveLength(1);
    expect(merged.some((e) => e.name === "grain")).toBe(true);
  });

  it("mergePresetEffects conserve les choix du scénario (premier arrivé maître)", () => {
    const existing = [{ name: "glitch", intensity: "strong" as const }];
    const merged = mergePresetEffects(existing, "dynamic");
    const glitch = merged.find((e) => e.name === "glitch");
    expect(glitch?.intensity).toBe("strong"); // intensité d'origine préservée
  });

  it("mergePresetEffects retourne la MÊME référence pour preset none", () => {
    const existing = [{ name: "vignette", intensity: "subtle" as const }];
    expect(mergePresetEffects(existing, "none")).toBe(existing);
  });

  it("chaque preset expose une motion du catalogue MOTION_PRESETS ou null", () => {
    const validMotions = ["static", "slow_zoom", "zoom_out", "ken_burns", "pan_left_right", "pan_right_left", "tilt_up", "tilt_down", "parallax", "dramatic_push"];
    for (const [preset, motion] of Object.entries(PRESET_MOTION)) {
      expect(motion === null || validMotions.includes(motion)).toBe(true);
      expect(preset).toBeTruthy();
    }
    expect(PRESET_MOTION.none).toBeNull();
  });

  it("presetIntensityLabel reste dans l'échelle fermée", () => {
    for (const preset of ["none", "subtle", "dynamic", "cinematic", "capcut"] as const) {
      expect(["subtle", "normal", "strong"]).toContain(presetIntensityLabel(preset));
    }
  });

  it("effectPresetFromText détecte les formulations FR courantes (unicode)", () => {
    expect(effectPresetFromText("une vidéo avec des effets dynamiques svp")).toBe("dynamic");
    expect(effectPresetFromText("montage comme CapCut")).toBe("capcut");
    expect(effectPresetFromText("je veux un style cinématique")).toBe("cinematic");
    expect(effectPresetFromText("des effets discrets")).toBe("subtle");
    expect(effectPresetFromText("sans effets du tout")).toBe("none");
    expect(effectPresetFromText("une vidéo sur les chats")).toBeNull();
  });
});

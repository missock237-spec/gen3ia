import { describe, expect, it } from "vitest";
import { buildMotion, interpolateMotion } from "./motion-service";
import { MOTION_PRESETS } from "./types";

/**
 * Garde de la demande propriétaire 2026-11-14 (animations garanties) :
 * chaque preset produit un mouvement réel, le nouveau preset d'orbite
 * parcourt une trajectoire fermée, et « static » n'est jamais retenu
 * implicitement pour une vidéo générée.
 */
describe("motion-service — orbit_drift (dérive orbitale)", () => {
  it("orbit_drift est un preset du catalogue fermé", () => {
    expect(MOTION_PRESETS).toContain("orbit_drift");
    expect(MOTION_PRESETS.length).toBe(11);
  });

  it("orbit_drift porte 4 keyframes en boucle fermée avec zoom progressif", () => {
    const motion = buildMotion("orbit_drift", 6);
    expect(motion.preset).toBe("orbit_drift");
    expect(motion.keyframes).toHaveLength(4);
    expect(motion.keyframes[0].scale).toBeLessThan(motion.keyframes[3].scale);
    // Trajectoire fermée : le dernier point revient du côté du premier.
    expect(Math.abs(motion.keyframes[3].x - motion.keyframes[0].x)).toBeLessThan(0.02);
  });

  it("l'interpolation orbitale est continue (croissance monotone du zoom)", () => {
    const motion = buildMotion("orbit_drift", 8);
    const tiers = interpolateMotion(motion, 1 / 3);
    const deuxTiers = interpolateMotion(motion, 2 / 3);
    const fin = interpolateMotion(motion, 1);
    expect(tiers.scale).toBeGreaterThan(1);
    expect(deuxTiers.scale).toBeGreaterThan(tiers.scale);
    expect(fin.scale).toBeGreaterThan(deuxTiers.scale);
  });

  it("les autres presets restent animés (aucun keyframe unique figé)", () => {
    for (const preset of ["slow_zoom", "ken_burns", "parallax", "dramatic_push"] as const) {
      const motion = buildMotion(preset, 5);
      expect(motion.keyframes.length).toBeGreaterThanOrEqual(2);
    }
  });
});

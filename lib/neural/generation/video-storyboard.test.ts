import { describe, expect, it } from "vitest";

import type { NeuralSnapshot } from "./snapshot";
import { analyserScenesMultiples } from "./scene-spec";
import { genererVideoScene } from "./video-storyboard";

/**
 * MOTEUR VIDÉO SCÉNIQUE v2 (storyboard) — verrous :
 *  1. chaque scène reconnue du prompt devient une scène animée (meta) ;
 *  2. ANIMATIONS SMIL présentes : caméra (animateTransform), fondus
 *     (animate opacity), météo vivante, oiseaux ;
 *  3. DÉTERMINISME bit-à-bit ;
 *  4. durée bornée (2–60 s) et répartie entre les scènes ;
 *  5. fond sombre de composition (pas de flash entre scènes).
 */

function snapshotFactice(seed = 2024): NeuralSnapshot {
  return {
    seed,
    nbNeurones: 120,
    nbSynapses: 480,
    poidsMoyen: 0.5,
    histogramme: Array.from({ length: 10 }, () => 0.1),
    echantillonSynapses: Array.from({ length: 80 }, (_, i) => [i, i + 2, 0.4] as [number, number, number]),
    energies: [],
    neuronTokens: [],
    tokens: ["phare"],
  };
}

describe("genererVideoScene — storyboard multi-scènes", () => {
  it("« un phare dans la tempête. puis la ville la nuit » → 2 scènes animées", () => {
    const scenes = analyserScenesMultiples("un phare dans la tempête. puis la ville la nuit");
    const rendu = genererVideoScene("un phare dans la tempête. puis la ville la nuit", 8, snapshotFactice(), scenes);
    expect(rendu.meta.nbScenes).toBe(2);
    expect(rendu.meta.dureeSceneS).toBe(4);
    expect(rendu.meta.scenes[0]?.sujet).toBe("phare");
    expect(rendu.meta.scenes[0]?.animations).toContain("eclair");
    expect(rendu.meta.scenes[1]?.cadre).toBe("ville");
    expect(rendu.meta.scenes[1]?.moment).toBe("nuit");
  });

  it("caméra SMIL par scène (pan/zoom alternés)", () => {
    const scenes = analyserScenesMultiples("un phare en mer. une forêt sous la pluie. un château. un désert");
    const rendu = genererVideoScene("un phare en mer. une forêt sous la pluie. un château. un désert", 12, snapshotFactice(), scenes);
    expect(rendu.meta.nbScenes).toBe(4);
    const cameras = rendu.meta.scenes.map((s) => s.animations[0]);
    expect(cameras).toEqual(["pan-droite", "zoom-avant", "pan-gauche", "zoom-arriere"]);
    expect(rendu.svg).toContain("animateTransform");
  });

  it("météo vivante : pluie animée qui tombe (translate), éclairs d'orage", () => {
    const scenes = analyserScenesMultiples("un phare dans la tempête");
    const rendu = genererVideoScene("un phare dans la tempête", 6, snapshotFactice(), scenes);
    expect(rendu.meta.scenes[0]?.animations).toContain("pluie-tombante");
    expect(rendu.svg).toContain('type="translate"');
    expect(rendu.svg).toContain("#F5D76E");
  });

  it("fondus enchaînés : fenêtres d'opacité par scène (keyTimes normalisés)", () => {
    const scenes = analyserScenesMultiples("un phare en mer. une ville la nuit");
    const rendu = genererVideoScene("un phare en mer. une ville la nuit", 10, snapshotFactice(), scenes);
    const keyTimes = rendu.svg.match(/keyTimes="([0-9.;]+)"/g) ?? [];
    expect(keyTimes.length).toBeGreaterThan(0);
    for (const match of keyTimes) {
      const valeurs = match.replace('keyTimes="', "").replace('"', "").split(";").map(Number);
      for (const v of valeurs) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("scène unique : fondu d'ouverture et de fermeture (boucle propre)", () => {
    const scenes = analyserScenesMultiples("un chat noir au bord de la mer");
    const rendu = genererVideoScene("un chat noir au bord de la mer", 6, snapshotFactice(), scenes);
    expect(rendu.meta.nbScenes).toBe(1);
    expect(rendu.svg).toContain('values="0;1;1;0"');
  });

  it("oiseaux animés pour les cadres naturels et le sujet oiseau", () => {
    const scenes = analyserScenesMultiples("un oiseau dans la forêt");
    const rendu = genererVideoScene("un oiseau dans la forêt", 6, snapshotFactice(), scenes);
    expect(rendu.meta.scenes[0]?.animations).toContain("oiseaux-en-vol");
  });

  it("sujet flottant : animateTransform posé sur le calque du sujet", () => {
    const scenes = analyserScenesMultiples("un voilier sur l'océan");
    const rendu = genererVideoScene("un voilier sur l'océan", 6, snapshotFactice(), scenes);
    // Le corps de scène anime le sujet (flottement) — deux niveaux d'animateTransform.
    expect((rendu.svg.match(/animateTransform/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("déterminisme bit-à-bit : même (prompt, snapshot, scènes) → même SVG", () => {
    const prompt = "un phare dans la tempête. puis la ville la nuit";
    const scenes = analyserScenesMultiples(prompt);
    const a = genererVideoScene(prompt, 8, snapshotFactice(555), scenes);
    const b = genererVideoScene(prompt, 8, snapshotFactice(555), scenes);
    expect(a.svg).toBe(b.svg);
  });

  it("durée bornée 2–60 s ; fond sombre de composition présent", () => {
    const scenes = analyserScenesMultiples("un phare en mer");
    expect(genererVideoScene("un phare en mer", 120, snapshotFactice(), scenes).dureeSecondes).toBe(60);
    expect(genererVideoScene("un phare en mer", 1, snapshotFactice(), scenes).dureeSecondes).toBe(2);
    expect(genererVideoScene("un phare en mer", 6, snapshotFactice(), scenes).svg).toContain('fill="#05050F"');
  });
});

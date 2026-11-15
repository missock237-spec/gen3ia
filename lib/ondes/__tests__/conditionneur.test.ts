import { describe, expect, it } from "vitest";

import {
  encoderImageEnOndeCible,
  encoderTexteEnOndeCible,
  hachagePrompt,
  imageSynthetique,
} from "@/lib/ondes/conditionneur";

describe("conditionneur d'ondes cibles (WaveConditioner)", () => {
  it("hachage du prompt : déterministe et insensible au signe (|hash % 1000|)", () => {
    expect(hachagePrompt("gen3")).toBe(hachagePrompt("gen3"));
    expect(hachagePrompt("gen3")).not.toBe(hachagePrompt("gen4"));
  });

  it("texte → onde cible : déterministe, bornée [-1, 1], taille exacte", () => {
    const a = encoderTexteEnOndeCible("rédiger un rapport d'analyse", 256);
    const b = encoderTexteEnOndeCible("rédiger un rapport d'analyse", 256);
    expect(a).toHaveLength(256);
    expect(Array.from(a)).toEqual(Array.from(b));
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("deux requêtes différentes → deux ondes cibles distinctes (discrimination)", () => {
    const a = encoderTexteEnOndeCible("générer une image photoréaliste", 512);
    const b = encoderTexteEnOndeCible("répondre à un questionnaire", 512);
    let differences = 0;
    for (let i = 0; i < 512; i++) {
      if (Math.abs(a[i] - b[i]) > 1e-6) differences++;
    }
    expect(differences).toBeGreaterThan(256);
  });

  it("image RGBA → onde spatiale : luminance normalisée [-1, 1] (portage fidèle)", () => {
    // Image 2×1 : pixel noir à gauche, pixel blanc à droite.
    const pixels = imageSynthetique(2, 1, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]));
    const onde = encoderImageEnOndeCible(pixels, 2, 1, 8);
    expect(onde).toHaveLength(8);
    // Échantillonnage régulier : les premiers nœuds tombent sur le noir.
    expect(onde[0]).toBeCloseTo(-1, 5);
    // Les nœuds couvrant le blanc montent vers +1.
    expect(Math.max(...Array.from(onde))).toBeCloseTo(1, 5);
  });

  it("image : garde-fous défensifs (taille RGBA incohérente, nœuds > pixels)", () => {
    const pixels = new Uint8ClampedArray(2 * 2 * 4);
    expect(() => encoderImageEnOndeCible(pixels, 4, 2, 8)).toThrow(/incohérente/);
    // Plus de nœuds que de pixels : pas forcé à 1, lecture hors contenu → 0.
    const onde = encoderImageEnOndeCible(new Uint8ClampedArray(4), 1, 1, 16);
    expect(onde).toHaveLength(16);
  });

  it("texte : entrées invalides refusées (nbNoeuds)", () => {
    expect(() => encoderTexteEnOndeCible("bonjour", 0)).toThrow(/Nombre de nœuds invalide/);
    expect(() => encoderTexteEnOndeCible("bonjour", 2.5)).toThrow(/Nombre de nœuds invalide/);
  });
});

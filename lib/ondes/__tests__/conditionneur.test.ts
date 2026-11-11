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
    // L'échantillonnage parcourt des pixels, pas les canaux RGBA.
    expect(onde[0]).toBeCloseTo(-1, 5);
    expect(onde[1]).toBeCloseTo(1, 5);
    // Les nœuds sans pixel disponible gardent la valeur neutre 0.
    expect(Array.from(onde.slice(2))).toEqual(new Array(6).fill(0));
  });

  it("image : échantillonne toujours des pixels RGBA entiers quand le pas n'est pas multiple de 4", () => {
    // 5 pixels, 3 nœuds : le pas théorique de l'ancien code valait 6 octets
    // et faisait lire le canal B puis les mauvais canaux au lieu des pixels.
    const pixels = imageSynthetique(5, 1, (x) => {
      if (x === 0) return [255, 0, 0]; // rouge
      if (x === 1) return [0, 255, 0]; // vert
      if (x === 2) return [0, 0, 255]; // bleu
      if (x === 3) return [255, 255, 255]; // blanc
      return [0, 0, 0]; // noir
    });
    const onde = encoderImageEnOndeCible(pixels, 5, 1, 3);
    expect(onde[0]).toBeCloseTo(2 * 0.299 - 1, 5); // pixel 0 : rouge
    expect(onde[1]).toBeCloseTo(2 * 0.587 - 1, 5); // pixel 1 : vert
    expect(onde[2]).toBeCloseTo(1, 5); // pixel 3 : blanc
  });

  it("image : garde-fous défensifs (taille RGBA incohérente, dimensions, nœuds > pixels)", () => {
    const pixels = new Uint8ClampedArray(2 * 2 * 4);
    expect(() => encoderImageEnOndeCible(pixels, 4, 2, 8)).toThrow(/incohérente/);
    expect(() => encoderImageEnOndeCible(pixels, 0, 2, 8)).toThrow(/Dimensions d'image invalides/);
    // Plus de nœuds que de pixels : pas de lecture d'alpha comme luminance.
    const onde = encoderImageEnOndeCible(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1, 16);
    expect(onde).toHaveLength(16);
    expect(onde[0]).toBeCloseTo(-1, 5);
    expect(Array.from(onde.slice(1))).toEqual(new Array(15).fill(0));
  });

  it("texte : entrées invalides refusées (nbNoeuds)", () => {
    expect(() => encoderTexteEnOndeCible("bonjour", 0)).toThrow(/Nombre de nœuds invalide/);
    expect(() => encoderTexteEnOndeCible("bonjour", 2.5)).toThrow(/Nombre de nœuds invalide/);
  });
});

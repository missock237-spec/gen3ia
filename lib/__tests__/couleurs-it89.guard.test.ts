import { describe, expect, it } from "vitest";

import {
  capaciteTotale,
  complementaire,
  echantillonCouleurs,
  depuisHex,
  melangeLumiere,
  melangePigment,
  parNom,
  PALETTE,
  qualifieLuminosite,
  questionCouleur,
  questionMelange,
  versHex,
  voisine,
  type Rgb,
} from "../gen3/couleurs-it89";

describe("Générateur couleurs it.89 (demande propriétaire : 10 M couleurs/propriétés/mélanges)", () => {
  it("capacité mesurée ≥ 10 000 000 questions vérifiables", () => {
    expect(capaciteTotale(1)).toBeGreaterThanOrEqual(10_000_000);
    // 256³ couleurs × 7 variantes + paires de mélanges
    expect(capaciteTotale(1)).toBe(16_777_216 * 7 + (24 * 23) / 2 * 2);
  });

  it("injectivité : zéro doublon de prompt sur 40 000 indices dispersés", () => {
    const echantillon = echantillonCouleurs(40_000, 20261103);
    const prompts = new Set(echantillon.map((q) => q.prompt));
    expect(prompts.size).toBe(echantillon.length);
  });

  it("déterminisme : même graine → même échantillon", () => {
    const a = echantillonCouleurs(500, 42);
    const b = echantillonCouleurs(500, 42);
    expect(a.map((q) => q.prompt)).toEqual(b.map((q) => q.prompt));
  });

  it("reconnaissance : les codes canoniques de la palette retombent sur leur nom", () => {
    for (const c of PALETTE) {
      const q = questionCouleur("R", c.rgb, 0);
      expect(q.extraitsVerifiables).toContain(c.nom);
      const rep = q.reponse;
      expect(rep).toContain(`Donc : ${versHex(c.rgb)} est le code du ${c.nom}`);
    }
  });

  it("propriétés : rouge chaud, bleu froid, blanc clair, noir sombre", () => {
    expect(questionCouleur("P", [255, 0, 0], 0).extraitsVerifiables).toContain("chaude");
    expect(questionCouleur("P", [0, 0, 255], 0).extraitsVerifiables).toContain("froide");
    expect(qualifieLuminosite([255, 255, 255])).toBe("claire");
    expect(qualifieLuminosite([0, 0, 0])).toBe("sombre");
  });

  it("mélanges lumière : rouge+vert=jaune, rouge+bleu=magenta, vert+bleu=cyan, tout=blanc", () => {
    expect(versHex(melangeLumiere([255, 0, 0], [0, 255, 0]))).toBe("#FFFF00");
    expect(versHex(melangeLumiere([255, 0, 0], [0, 0, 255]))).toBe("#FF00FF");
    expect(versHex(melangeLumiere([0, 255, 0], [0, 0, 255]))).toBe("#00FFFF");
    expect(voisine(melangeLumiere([255, 255, 0], [0, 0, 255])).nom).toBe("blanc");
    const q = questionMelange(parNom("rouge")!, parNom("vert")!, "lumiere");
    expect(q.extraitsVerifiables).toContain("#FFFF00");
    expect(q.extraitsVerifiables).toContain("jaune");
  });

  it("mélanges pigments : la formule soustractive donne un résultat plus sombre", () => {
    const a = parNom("jaune")!.rgb;
    const b = parNom("cyan")!.rgb;
    const lp = melangePigment(a, b);
    const ll = melangeLumiere(a, b);
    const lum = (c: Rgb) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    expect(lum(lp)).toBeLessThan(lum(ll));
    const q = questionMelange(parNom("jaune")!, parNom("cyan")!, "pigment");
    expect(q.extraitsVerifiables.some((e) => e.startsWith("#"))).toBe(true);
  });

  it("complémentaire : inversion des canaux, cyan = complémentaire du rouge", () => {
    expect(versHex(complementaire([255, 0, 0]))).toBe("#00FFFF");
    const q = questionCouleur("C", [255, 0, 0], 0);
    expect(q.extraitsVerifiables).toContain("#00FFFF");
    expect(q.extraitsVerifiables).toContain("cyan");
  });

  it("décomposition hexadécimale : canaux exacts", () => {
    const q = questionCouleur("H", depuisHex("#4B0082")!, 0);
    expect(q.extraitsVerifiables).toContain("rouge = 75");
    expect(q.extraitsVerifiables).toContain("vert = 0");
    expect(q.extraitsVerifiables).toContain("bleu = 130");
  });

  it("l'échantillon stratifié est vérifiable par re-calcul (source de vérité unique)", () => {
    const echantillon = echantillonCouleurs(2_000, 7);
    for (const q of echantillon) {
      // chaque extrait vérifiable figure dans la réponse générée
      for (const ex of q.extraitsVerifiables) {
        expect(q.reponse.toLowerCase()).toContain(ex.toLowerCase());
      }
    }
  });
});

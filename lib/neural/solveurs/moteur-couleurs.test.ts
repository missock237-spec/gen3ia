import { describe, expect, it } from "vitest";

import {
  contrasteWcag,
  hexVersRgb,
  luminanceRelative,
  resoudreCouleurs,
  rgbVersHsl,
  rgbVersHex,
  simulerDaltonisme,
} from "./moteur-couleurs";

describe("conversions colorimétriques (formules standards)", () => {
  it("hex↔rgb aller-retour", () => {
    expect(hexVersRgb("#ff0000")).toEqual([255, 0, 0]);
    expect(rgbVersHex(255, 0, 0)).toBe("#ff0000");
    expect(rgbVersHex(0x2e, 0x9e, 0x4f)).toBe("#2e9e4f");
  });

  it("HSL du rouge pur = (0°, 100%, 50%)", () => {
    const [h, s, l] = rgbVersHsl(255, 0, 0);
    expect(Math.round(h)).toBe(0);
    expect(Math.round(s)).toBe(100);
    expect(Math.round(l)).toBe(50);
  });

  it("luminance du blanc = 1.0, du noir = 0.0", () => {
    expect(luminanceRelative(255, 255, 255)).toBeCloseTo(1.0, 3);
    expect(luminanceRelative(0, 0, 0)).toBeCloseTo(0.0, 3);
  });

  it("contraste blanc/noir = 21:1 (WCAG)", () => {
    expect(contrasteWcag([255, 255, 255], [0, 0, 0])).toBeCloseTo(21.0, 1);
  });
});

describe("simulation du daltonisme (matrices Machado 2009)", () => {
  it("le rouge pur vu par un protanope perd sa dominante rouge", () => {
    const [r, g, b] = simulerDaltonisme([255, 0, 0], "protanopie");
    expect(r).toBeLessThan(255);
    expect(g).toBeGreaterThan(0);
    expect(b).toBe(0);
  });
  it("le blanc reste blanc pour tous les types", () => {
    for (const t of ["protanopie", "deuteranopie", "tritanopie"] as const) {
      expect(simulerDaltonisme([255, 255, 255], t)).toEqual([255, 255, 255]);
    }
  });
});

describe("resoudreCouleurs — réponses exactes", () => {
  it("propriétés d'une couleur nommée", () => {
    const r = resoudreCouleurs("Donne les propriétés de la couleur rouge");
    expect(r).not.toBeNull();
    expect(r).toContain("#ff0000");
    expect(r).toContain("RGB (255, 0, 0)");
  });

  it("propriétés d'un hex direct", () => {
    const r = resoudreCouleurs("Quelles sont les propriétés de #3498db ?");
    expect(r).not.toBeNull();
    expect(r).toContain("(52, 152, 219)");
  });

  it("mélanges artistiques documentés : rouge + jaune = orange", () => {
    const r = resoudreCouleurs("Que donne le mélange du rouge et du jaune ?");
    expect(r).not.toBeNull();
    expect(r?.toLowerCase()).toContain("orange");
  });

  it("mélange numérique de deux hex", () => {
    const r = resoudreCouleurs("Mix #ff0000 and #00ff00");
    expect(r).not.toBeNull();
    expect(r).toContain("#808000");
  });

  it("complémentaire du rouge = cyan", () => {
    const r = resoudreCouleurs("Quelle est la couleur complémentaire du rouge ?");
    expect(r).not.toBeNull();
    expect(r).toContain("#00ffff");
  });

  it("contraste WCAG avec verdict", () => {
    const r = resoudreCouleurs("Quel est le contraste WCAG de #000000 contre le blanc ?");
    expect(r).not.toBeNull();
    expect(r).toContain("21.00:1");
    expect(r).toContain("AAA");
  });

  it("daltonisme : simulation expliquée", () => {
    const r = resoudreCouleurs("Comment un daltonien perçoit-il le vert (deutéranopie) ?");
    expect(r).not.toBeNull();
    expect(r).toContain("deuteranopie");
    expect(r).toContain("Machado");
  });

  it("identification hex → couleur nommée la plus proche", () => {
    const r = resoudreCouleurs("Which color is #ff6347 ?");
    expect(r).not.toBeNull();
    expect(r!.toLowerCase()).toContain("tomato");
  });

  it("null hors couleurs (pas de fausse détection)", () => {
    expect(resoudreCouleurs("Écris un poème sur l'automne")).toBeNull();
  });
});

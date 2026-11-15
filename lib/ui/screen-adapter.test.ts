import { describe, expect, it } from "vitest";

import {
  backdropClass,
  inlinePanelClass,
  MOBILE_HEADER_BUTTON_CLASS,
  overlaySheetClass,
} from "./screen-adapter";

/**
 * Étape 10 du plan 20 — adaptateur d'écran. Contrats verrouillés :
 *  1. les panneaux inline restent le comportement ≥ lg ;
 *  2. une feuille fermée est cachée, une feuille ouverte est superposée
 *     avec la bordure du bon côté et sans dépasser l'écran (85vw max) ;
 *  3. le fond d'obstruction n'existe que feuille ouverte ;
 *  4. les boutons d'en-tête mobiles ne s'affichent pas sur grand écran.
 */
describe("inlinePanelClass", () => {
  it("cache en mobile, affiche en colonne sur lg — les deux côtés", () => {
    for (const side of ["left", "right"] as const) {
      expect(inlinePanelClass(side)).toContain("hidden lg:block");
    }
  });
});

describe("overlaySheetClass", () => {
  it("une feuille fermée est cachée mais prête (position, largeur bornée)", () => {
    const closed = overlaySheetClass(false, "left");
    expect(closed).toContain("hidden");
    expect(closed).toContain("lg:hidden");
    expect(closed).toContain("max-w-[85vw]");
  });

  it("une feuille ouverte est superposée au-dessus du fond (z-50) avec la bordure du bon côté", () => {
    const tokens = (value: string) => value.split(" ");
    const left = overlaySheetClass(true, "left");
    expect(tokens(left)).not.toContain("hidden"); // ouverte : jamais cachée (lg:hidden est un token distinct)
    expect(left).toContain("left-0");
    expect(left).toContain("border-r");
    const right = overlaySheetClass(true, "right");
    expect(right).toContain("right-0");
    expect(right).toContain("border-l");
  });

  it("la feuille reste invisible sur grand écran (lg:hidden) même ouverte", () => {
    expect(overlaySheetClass(true, "left")).toContain("lg:hidden");
  });
});

describe("backdropClass", () => {
  it("n'existe que pour une feuille ouverte et passe sous la feuille (z-40)", () => {
    expect(backdropClass(false)).toBe("hidden");
    expect(backdropClass(true)).toContain("z-40");
    expect(backdropClass(true)).toContain("lg:hidden");
  });
});

describe("MOBILE_HEADER_BUTTON_CLASS", () => {
  it("les boutons mobiles sont masqués sur grand écran", () => {
    expect(MOBILE_HEADER_BUTTON_CLASS).toContain("lg:hidden");
  });
});

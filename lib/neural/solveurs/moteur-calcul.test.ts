import { describe, expect, it } from "vitest";

import { resoudreCalcul } from "./moteur-calcul";

describe("moteur-calcul — réponses exactes (sans eval)", () => {
  it("calcul simple explicite", () => {
    expect(resoudreCalcul("Calcule 12 + 34")).toContain("46");
  });

  it("chaîne d'opérations avec étapes", () => {
    const r = resoudreCalcul("Calcule 480 - 60 + 25");
    expect(r).not.toBeNull();
    expect(r).toContain("445");
    expect(r).toContain("Étape");
  });

  it("multiplication et division avec symboles unicode", () => {
    expect(resoudreCalcul("Combien font 25 × 4 ?")).toContain("100");
    expect(resoudreCalcul("Compute 100 ÷ 8")).toContain("12.5");
  });

  it("parenthèses et priorité", () => {
    expect(resoudreCalcul("Calcule (12 + 8) × 3")).toContain("60");
    expect(resoudreCalcul("Calcule 2 + 3 × 4")).toContain("14");
  });

  it("puissances", () => {
    expect(resoudreCalcul("Calcule 2 ^ 10")).toContain("1024");
  });

  it("racines carrées", () => {
    expect(resoudreCalcul("Calcule sqrt(144)")).toContain("12");
  });

  it("pourcentage « X% de Y »", () => {
    const r = resoudreCalcul("Calcule 20% de 150");
    expect(r).not.toBeNull();
    expect(r).toContain("30");
  });

  it("augmentation/réduction en pourcentage", () => {
    const r = resoudreCalcul("150 + 10%");
    expect(r).not.toBeNull();
    expect(r).toContain("165");
  });

  it("nombres décimaux", () => {
    expect(resoudreCalcul("Calcule 2.5 * 4")).toContain("10");
  });

  it("division par zéro : null (pas de réponse fausse)", () => {
    expect(resoudreCalcul("Calcule 5 / 0")).toBeNull();
  });

  it("null hors calcul (pas de fausse détection)", () => {
    expect(resoudreCalcul("Rédige un rapport de vente pour le trimestre")).toBeNull();
    expect(resoudreCalcul("Bonjour, comment vas-tu ?")).toBeNull();
  });
});

/**
 * GARDE COMPARTIMENT MATH — le compartiment doit CALCULER (jamais réciter)
 * avec un évaluateur écrit à la main (zéro eval, zéro Function), des
 * étapes complètes, et refuser proprement ce qui n'est pas calculable.
 */
import { describe, expect, it } from "vitest";

import {
  estExpressionPure,
  evaluerExpression,
  formaterNombre,
  formuleReponse,
  resoudreProbleme,
} from "./moteur-math";

describe("compartiment math — évaluateur d'expressions (sans eval)", () => {
  it("respecte les priorités d'opérateurs et les parenthèses", () => {
    expect(evaluerExpression("3+4*2")).toBe(11);
    expect(evaluerExpression("(3+4)*2")).toBe(14);
    expect(evaluerExpression("17*23")).toBe(391);
    expect(evaluerExpression("2^10")).toBe(1024);
    expect(evaluerExpression("2^3^2")).toBe(512); // associativité à droite
    expect(evaluerExpression("100/4/5")).toBe(5);
  });

  it("accepte la virgule française, le % postfixé et les fonctions", () => {
    expect(evaluerExpression("3,5+1,5")).toBe(5);
    expect(evaluerExpression("15%")).toBeCloseTo(0.15, 10);
    expect(evaluerExpression("sqrt(144)")).toBe(12);
    expect(evaluerExpression("abs(-7)")).toBe(7);
    expect(evaluerExpression("pi")).toBeCloseTo(Math.PI, 12);
    expect(evaluerExpression("sindeg(30)")).toBeCloseTo(0.5, 10);
  });

  it("refuse les identifiants inconnus, les divisions par zéro, le code hostile", () => {
    expect(evaluerExpression("process()")).toBeNull();
    expect(evaluerExpression("constructor")).toBeNull();
    expect(evaluerExpression("1/0")).toBeNull();
    expect(evaluerExpression("(3+4")).toBeNull();
    expect(evaluerExpression("3+")).toBeNull();
    expect(evaluerExpression("")).toBeNull();
  });

  it("estExpressionPure ne déclenche que sur de vraies expressions", () => {
    expect(estExpressionPure("(3+4)*2")).toBe(true);
    expect(estExpressionPure("42")).toBe(false); // un nombre seul n'est pas un calcul
    expect(estExpressionPure("bonjour")).toBe(false);
    expect(estExpressionPure("17*23")).toBe(true);
  });
});

describe("compartiment math — familles de problèmes", () => {
  it("résout une expression explicite posée en français", () => {
    const r = resoudreProbleme("Calcule 17*23");
    expect(r.resolu).toBe(true);
    expect(r.valeur).toBe(391);
    expect(r.famille).toBe("expression");
    expect(r.etapes.length).toBeGreaterThan(0);
  });

  it("résout les pourcentages (part, augmentation, réduction, proportion)", () => {
    expect(resoudreProbleme("15 % de 240").valeur).toBe(36);
    expect(resoudreProbleme("200 augmenté de 10 %").valeur).toBeCloseTo(220, 9);
    expect(resoudreProbleme("200 réduit de 25 %").valeur).toBeCloseTo(150, 9);
    const pct = resoudreProbleme("quel pourcentage de 50 dans 200");
    expect(pct.valeur).toBeCloseTo(25, 9);
    expect(pct.unite).toBe("%");
  });

  it("résout les conversions d'unités par facteurs exacts", () => {
    const km = resoudreProbleme("convertis 2,5 km en m");
    expect(km.valeur).toBe(2500);
    expect(km.unite).toBe("m");
    expect(resoudreProbleme("3 h en min").valeur).toBe(180);
    expect(resoudreProbleme("1,5 kg en g").valeur).toBe(1500);
    // familles incompatibles : refus honnête
    expect(resoudreProbleme("convertis 3 km en kg").resolu).toBe(false);
  });

  it("résout la moyenne, l'aire, le périmètre et Pythagore", () => {
    expect(resoudreProbleme("moyenne de 12, 14 et 16").valeur).toBe(14);
    expect(resoudreProbleme("aire d'un carré de côté 5").valeur).toBe(25);
    expect(resoudreProbleme("aire d'un rectangle de longueur 6 et largeur 4").valeur).toBe(24);
    expect(resoudreProbleme("aire d'un triangle de base 10 et hauteur 3").valeur).toBe(15);
    expect(resoudreProbleme("périmètre d'un carré de côté 5").valeur).toBe(20);
    const cercle = resoudreProbleme("aire d'un cercle de rayon 2");
    expect(cercle.valeur).toBeCloseTo(4 * Math.PI, 9);
    expect(resoudreProbleme("hypoténuse d'un triangle rectangle de côtés 3 et 4").valeur).toBe(5);
  });

  it("résout le partage et la vitesse", () => {
    expect(resoudreProbleme("partage 120 entre 4").valeur).toBe(30);
    expect(resoudreProbleme("divise 120 par 8").valeur).toBe(15);
    expect(resoudreProbleme("360 km en 4 h").valeur).toBe(90);
    expect(resoudreProbleme("90 km/h pendant 3 h").valeur).toBe(270);
  });

  it("ne résout PAS ce qui n'est pas un calcul (pas de fausse certitude)", () => {
    expect(resoudreProbleme("quel est le capital de la France").resolu).toBe(false);
    expect(resoudreProbleme("bonjour gen3").resolu).toBe(false);
    expect(resoudreProbleme("").resolu).toBe(false);
  });
});

describe("compartiment math — formatage et déterminisme", () => {
  it("formate en français (virgule décimale, arrondi millionième)", () => {
    expect(formaterNombre(0.1 + 0.2)).toBe("0,3");
    expect(formaterNombre(2500)).toBe("2500");
    expect(formaterNombre(-0)).toBe("0");
  });

  it("est déterministe : même question → même résultat, deux fois", () => {
    const a = resoudreProbleme("convertis 2,5 km en m");
    const b = resoudreProbleme("convertis 2,5 km en m");
    expect(b).toEqual(a);
  });

  it("la réponse formulée porte le résultat ET les étapes", () => {
    const r = resoudreProbleme("15 % de 240");
    const texte = formuleReponse(r);
    expect(texte).toContain("36");
    expect(texte).toContain("Étapes du calcul");
    expect(texte).toContain("[Compartiment math]");
  });
});

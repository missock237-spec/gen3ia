import { describe, expect, it } from "vitest";

import { compilerExpression, ErreurExpression, tenterCompiler } from "../expression";

describe("expression — compilation sûre", () => {
  it("évalue une expression simple avec précédences correctes", () => {
    const e = compilerExpression("2 + 3 * 4");
    expect(e.evaluer({})).toBe(14);
  });

  it("respecte les parenthèses et la puissance droite-associative", () => {
    expect(compilerExpression("(2 + 3) * 4").evaluer({})).toBe(20);
    expect(compilerExpression("2 ^ 3 ^ 2").evaluer({})).toBe(512);
  });

  it("évalue les variables et fonctions usuelles", () => {
    const e = compilerExpression("sin(x) * cos(y) + sqrt(x^2 + y^2)");
    expect(e.evaluer({ x: 3, y: 4 })).toBeCloseTo(Math.sin(3) * Math.cos(4) + 5, 10);
  });

  it("gère l'unaire moins et les constantes", () => {
    expect(compilerExpression("-3 + pi").evaluer({})).toBeCloseTo(Math.PI - 3, 12);
    expect(compilerExpression("2 * e").evaluer({})).toBeCloseTo(2 * Math.E, 12);
  });

  it("min/max à deux arguments", () => {
    expect(compilerExpression("min(3, 7)").evaluer({})).toBe(3);
    expect(compilerExpression("max(3, 7)").evaluer({})).toBe(7);
  });

  it("notation scientifique", () => {
    expect(compilerExpression("1.5e-3 * 2").evaluer({})).toBeCloseTo(0.003, 12);
  });
});

describe("expression — refus des constructions dangereuses", () => {
  it("refuse les symboles inconnus", () => {
    expect(() => compilerExpression("malware(x)")).toThrow(ErreurExpression);
  });

  it("refuse les variables non autorisées", () => {
    expect(() => compilerExpression("process + 1")).toThrow(ErreurExpression);
  });

  it("refuse les caractères étrangers", () => {
    expect(() => compilerExpression("1 ; drop table")).toThrow(ErreurExpression);
    expect(() => compilerExpression("`rm -rf`")).toThrow(ErreurExpression);
    expect(() => compilerExpression("x && y")).toThrow(ErreurExpression);
  });

  it("refuse les expressions incomplètes ou déséquilibrées", () => {
    expect(() => compilerExpression("(1 + 2")).toThrow(ErreurExpression);
    expect(() => compilerExpression("1 +")).toThrow(ErreurExpression);
    expect(() => compilerExpression("sin")).toThrow(ErreurExpression);
    expect(() => compilerExpression("min(1)")).toThrow(ErreurExpression);
    expect(() => compilerExpression("")).toThrow(ErreurExpression);
  });

  it("tenterCompiler renvoie null au lieu de lever", () => {
    expect(tenterCompiler("x + 1")).not.toBeNull();
    expect(tenterCompiler("eval(malicious)")).toBeNull();
  });

  it("n'exécute JAMAIS de code : l'évaluation ne produit que des nombres", () => {
    const e = compilerExpression("x * 2");
    const resultat = e.evaluer({ x: 21 });
    expect(typeof resultat).toBe("number");
    expect(resultat).toBe(42);
  });
});

describe("expression — robustesse", () => {
  it("variables manquantes donnent NaN (pas de crash)", () => {
    const e = compilerExpression("x + 1");
    expect(Number.isNaN(e.evaluer({}))).toBe(true);
  });

  it("division par zéro donne Infinity sans crash", () => {
    expect(compilerExpression("1 / x").evaluer({ x: 0 })).toBe(Infinity);
  });

  it("expressions longues mais valides passent", () => {
    const e = compilerExpression("x + x + x + x + x");
    expect(e.evaluer({ x: 2 })).toBe(10);
  });
});

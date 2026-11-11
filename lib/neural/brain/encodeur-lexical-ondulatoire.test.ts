import { describe, expect, it } from "vitest";

import { encoderTexteLexicalEnOnde } from "./encodeur-lexical-ondulatoire";

function cosinus(a: Float32Array, b: Float32Array): number {
  let produit = 0;
  let normeA = 0;
  let normeB = 0;
  for (let i = 0; i < a.length; i++) {
    produit += a[i] * b[i];
    normeA += a[i] * a[i];
    normeB += b[i] * b[i];
  }
  return produit / Math.sqrt(normeA * normeB);
}

describe("encoderTexteLexicalEnOnde", () => {
  it("est déterministe et produit un vecteur de taille fixe normalisé", () => {
    const a = encoderTexteLexicalEnOnde("La capitale du Cameroun", 128);
    const b = encoderTexteLexicalEnOnde("La capitale du Cameroun", 128);
    expect(a).toEqual(b);
    expect(a).toHaveLength(128);
    const norme = Math.sqrt(Array.from(a).reduce((sum, x) => sum + x * x, 0));
    expect(norme).toBeCloseTo(1, 5);
  });

  it("reflète le recouvrement lexical entre formulations proches", () => {
    const a = encoderTexteLexicalEnOnde("capitale du cameroun", 512);
    const b = encoderTexteLexicalEnOnde("quelle est la capitale du cameroun", 512);
    const c = encoderTexteLexicalEnOnde("la météo demain à Tokyo", 512);
    expect(cosinus(a, b)).toBeGreaterThan(cosinus(a, c));
  });

  it("normalise la casse, les espaces et les accents", () => {
    const a = encoderTexteLexicalEnOnde("ÉLÈVE du CAMEROUN", 128);
    const b = encoderTexteLexicalEnOnde("eleve   du cameroun", 128);
    expect(a).toEqual(b);
  });

  it("refuse les entrées vides, les dimensions invalides et les poids hors limites", () => {
    expect(() => encoderTexteLexicalEnOnde(" ", 32)).toThrow(/vide/);
    expect(() => encoderTexteLexicalEnOnde("test", 4)).toThrow(/taille/);
    expect(() => encoderTexteLexicalEnOnde("test", 32, { poidsMot: Number.NaN })).toThrow(/poids/);
  });
});

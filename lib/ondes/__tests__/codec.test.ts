import { describe, expect, it } from "vitest";

import {
  champVersVecteur,
  celluleComposante,
  cosinus,
  empreinteVecteur,
  normaliserVecteur,
  texteVersVecteur,
  vecteurVersImpulsions,
  MAX_COMPOSANTES_ENCODEES,
} from "@/lib/ondes/codec";

const DIM = 128;

describe("codec onde-vecteur — le traducteur universel", () => {
  it("attribue à chaque composante une cellule déterministe et injective", () => {
    const vues = new Set<number>();
    for (let i = 0; i < 512; i++) {
      const c1 = celluleComposante(i, DIM);
      const c2 = celluleComposante(i, DIM);
      expect(c2).toEqual(c1); // déterministe
      vues.add(c1.y * DIM + c1.x);
    }
    expect(vues.size).toBe(512); // injectif sur l'échantillon
  });

  it("normalise un vecteur dans [-1, 1] et préserve les proportions", () => {
    const v = normaliserVecteur([2, -4, 1]);
    expect(Math.max(...v)).toBeLessThanOrEqual(1);
    expect(Math.min(...v)).toBeGreaterThanOrEqual(-1);
    expect(v[1]).toBe(-1); // la composante de norme max devient ±1
    expect(v[0] / v[2]).toBeCloseTo(2, 10);
  });

  it("encode un vecteur en impulsions : même index → même cellule, signe transporté par l'amplitude", () => {
    const v = new Float64Array(256);
    v[3] = 8; // composante positive dominante
    v[7] = -8; // composante négative dominante
    const a = vecteurVersImpulsions(v, DIM);
    const b = vecteurVersImpulsions(v, DIM);
    expect(b).toEqual(a); // déterminisme total

    const cell3 = celluleComposante(3, DIM);
    const cell7 = celluleComposante(7, DIM);
    const imp3 = a.find((imp) => imp.x === cell3.x && imp.y === cell3.y);
    const imp7 = a.find((imp) => imp.x === cell7.x && imp.y === cell7.y);
    expect(imp3).toBeDefined();
    expect(imp7).toBeDefined();
    expect(imp3!.amplitude).toBeGreaterThan(0);
    expect(imp7!.amplitude).toBeLessThan(0); // le signe devient l'opposition de phase
  });

  it("ne garde que les composantes les plus fortes au-delà du plafond physique", () => {
    const v = new Float64Array(1000);
    for (let i = 0; i < 1000; i++) v[i] = (i % 7) + 0.1;
    const impulsions = vecteurVersImpulsions(v, DIM);
    expect(impulsions.length).toBe(MAX_COMPOSANTES_ENCODEES);
  });

  it("relit un champ injecté : le vecteur décodé retrouve les composantes et leur signe", () => {
    const v = new Float64Array(256);
    v[5] = 6;
    v[11] = -6;
    const impulsions = vecteurVersImpulsions(v, DIM);
    // Champ vierge + injection SANS propagation : lecture exacte.
    const champ = new Float32Array(DIM * DIM);
    for (const imp of impulsions) {
      champ[Math.round(imp.y) * DIM + Math.round(imp.x)] = imp.amplitude;
    }
    const lu = champVersVecteur(champ, DIM, 256);
    expect(lu[5]).toBeGreaterThan(0);
    expect(lu[11]).toBeLessThan(0);
    expect(Math.abs(lu[5])).toBeCloseTo(Math.abs(lu[11]), 5);
  });

  it("deux textes identiques donnent le même vecteur, deux textes différents divergent", () => {
    const a = texteVersVecteur("Bonjour le monde de l'IA", 256);
    const b = texteVersVecteur("Bonjour le monde de l'IA", 256);
    const c = texteVersVecteur("Équation de Schrödinger et quantique", 256);
    expect([...a]).toEqual([...b]);
    expect(cosinus(a, c)).toBeLessThan(cosinus(a, b));
  });

  it("l'empreinte d'un vecteur est stable et sensible au contenu", () => {
    const v1 = texteVersVecteur("résonance constructive", 128);
    const v2 = texteVersVecteur("résonance constructive", 128);
    const v3 = texteVersVecteur("annihilation destructive", 128);
    expect(empreinteVecteur(v1)).toBe(empreinteVecteur(v2));
    expect(empreinteVecteur(v3)).not.toBe(empreinteVecteur(v1));
  });
});

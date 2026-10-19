import { describe, expect, it } from "vitest";

import {
  deriveeNumerique,
  dichotomie,
  dft,
  integrerRk4,
  laplacien2D,
  minimiser1D,
  monteCarloIntegrale,
  newtonRacine,
  picMaximum,
  tridiagonal,
} from "../solveurs";

describe("solveurs — intégration RK4", () => {
  it("intègre y' = y vers e^t (erreur RK4 ~ h⁴)", () => {
    const res = integrerRk4((_t, y) => [y[0]], [1], 0, 1, 0.001, 64);
    const finale = res.series[res.series.length - 1][0];
    expect(finale).toBeCloseTo(Math.E, 4);
  });

  it("intègre le système harmonique en conservant l'amplitude", () => {
    // x'' = −x : solution x = cos(t), amplitude constante.
    const res = integrerRk4((_t, y) => [y[1], -y[0]], [1, 0], 0, 2 * Math.PI, 0.001, 64);
    const finale = res.series[res.series.length - 1][0];
    expect(finale).toBeCloseTo(1, 4);
    expect(res.series[res.series.length - 1][1]).toBeCloseTo(0, 3);
  });
});

describe("solveurs — racines et optimisation", () => {
  it("dichotomie trouve la racine de x² − 2", () => {
    const r = dichotomie((x) => x * x - 2, 0, 2);
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(Math.SQRT2, 8);
  });

  it("dichotomie renvoie null sans changement de signe", () => {
    expect(dichotomie((x) => x * x + 1, -1, 1)).toBeNull();
  });

  it("Newton trouve la racine de cos(x) − x", () => {
    const r = newtonRacine((x) => Math.cos(x) - x, 1);
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(0.7390851332151607, 8);
  });

  it("section dorée minimise x² + 3x + 1 en x = −1.5", () => {
    const x = minimiser1D((v) => v * v + 3 * v + 1, -5, 5);
    expect(x).toBeCloseTo(-1.5, 6);
  });
});

describe("solveurs — champs et systèmes linéaires", () => {
  it("laplacien 5 points d'un champ constant est nul", () => {
    const n = 8;
    const champ = new Float64Array(n * n).fill(5);
    const sortie = new Float64Array(n * n);
    laplacien2D(champ, n, n, sortie);
    for (const v of sortie) expect(v).toBe(0);
  });

  it("laplacien détecte la courbure d'un puits quadratique", () => {
    const n = 10;
    const champ = new Float64Array(n * n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) champ[j * n + i] = i * i;
    const sortie = new Float64Array(n * n);
    laplacien2D(champ, n, n, sortie);
    // En intérieur, ∇²(i²) = 2 + 0 = 2 (lignes constantes).
    expect(sortie[5 * n + 5]).toBeCloseTo(2, 10);
  });

  it("Thomas résout un système tridiagonal exactement", () => {
    // Système : [2 1 0; 1 3 1; 0 1 2]·x = [3; 5; 5] → x = [1.25; 0.5; 2.25]
    const x = tridiagonal([0, 1, 1], [2, 3, 2], [1, 1, 0], [3, 5, 5]);
    expect(x[0]).toBeCloseTo(1.25, 10);
    expect(x[1]).toBeCloseTo(0.5, 10);
    expect(x[2]).toBeCloseTo(2.25, 10);
  });
});

describe("solveurs — Fourier et Monte-Carlo", () => {
  it("DFT d'une sinusoïde pure localise la fréquence", () => {
    const n = 64;
    const signal = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 5 * i) / n));
    const { re, im } = dft(signal);
    const spectre = re.map((r, k) => Math.hypot(r, im[k]));
    // Signal réel : spectre symétrique (k et n−k). On cherche dans la
    // première moitié seulement.
    const moitie = spectre.slice(0, n / 2);
    const kMax = moitie.indexOf(Math.max(...moitie));
    expect(kMax).toBe(5);
  });

  it("Monte-Carlo intègre x² sur [0;1] vers 1/3", () => {
    const { valeur } = monteCarloIntegrale((x) => x * x, 0, 1, 200_000, 7);
    expect(valeur).toBeCloseTo(1 / 3, 2);
  });

  it("Monte-Carlo est déterministe à graine fixe", () => {
    const a = monteCarloIntegrale(Math.exp, 0, 1, 10_000, 42);
    const b = monteCarloIntegrale(Math.exp, 0, 1, 10_000, 42);
    expect(a.valeur).toBe(b.valeur);
  });
});

describe("solveurs — outils", () => {
  it("dérivée numérique centrale de sin en 0 = 1", () => {
    expect(deriveeNumerique(Math.sin, 0)).toBeCloseTo(1, 6);
  });

  it("picMaximum localise le plus grand module", () => {
    const { index, valeur } = picMaximum([1, -2, 3, -8, 2]);
    expect(index).toBe(3);
    expect(valeur).toBe(8);
  });
});

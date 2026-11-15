import { describe, expect, it } from "vitest";

import {
  analyserSpectre,
  fftRadix2,
  fenetreHann,
  prosodieDepuisResonance,
  versImpulsionsOndes,
} from "../vocal/spectre";

/** Sinusoïde pure : l'essai de vérité de toute FFT. */
function sinus(frequenceCycles: number, n: number): Float32Array {
  const echantillons = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    echantillons[i] = Math.sin((2 * Math.PI * frequenceCycles * i) / n);
  }
  return echantillons;
}

describe("fftRadix2 — l'exactitude avant tout", () => {
  it("reproduit la DFT d'un sinus pur (comparaison directe)", () => {
    const n = 256;
    const cycles = 10;
    const reel = Float32Array.from(sinus(cycles, n));
    const imag = new Float32Array(n);

    fftRadix2(reel, imag);

    // DFT naïve au bin 10 (référence indépendante).
    let sommeRe = 0;
    let sommeIm = 0;
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * cycles * t) / n;
      sommeRe += Math.sin((2 * Math.PI * cycles * t) / n) * Math.cos(angle);
      sommeIm += Math.sin((2 * Math.PI * cycles * t) / n) * Math.sin(angle);
    }
    expect(reel[cycles]).toBeCloseTo(sommeRe, 3);
    expect(imag[cycles]).toBeCloseTo(sommeIm, 3);

    // Un sinus pur : les autres bins sont quasi nuls.
    for (let k = 1; k < n / 2; k++) {
      if (k === cycles || k === n - cycles) continue;
      expect(Math.hypot(reel[k], imag[k])).toBeLessThan(1);
    }
  });

  it("la transformée inverse (par conjugaison) restitue le signal", () => {
    const n = 64;
    const original = sinus(5, n);
    const reel = Float32Array.from(original);
    const imag = new Float32Array(n);
    fftRadix2(reel, imag);

    // FFT inverse via conjugué : IFFT(x) = conj(FFT(conj(X)))/n.
    for (let i = 0; i < n; i++) imag[i] = -imag[i];
    fftRadix2(reel, imag);
    for (let i = 0; i < n; i++) {
      reel[i] /= n;
      imag[i] = -imag[i] / n;
    }
    for (let i = 0; i < n; i++) {
      expect(reel[i]).toBeCloseTo(original[i], 3);
    }
  });

  it("exige une puissance de 2", () => {
    expect(() => fftRadix2(new Float32Array(100), new Float32Array(100))).toThrow(/puissance de 2/);
  });
});

describe("analyserSpectre — de la voix aux impulsions", () => {
  it("trouve la note jouée (440 Hz sur 48 kHz)", () => {
    const frequenceEchantillonnage = 48_000;
    const n = 2048;
    const echantillons = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      echantillons[i] = Math.sin((2 * Math.PI * 440 * i) / frequenceEchantillonnage);
    }
    const impulsions = analyserSpectre(echantillons);
    expect(impulsions.length).toBeGreaterThan(0);
    // Le pic dominant est au bin 440 / (48000/2048) ≈ 19.
    const bin440 = impulsions[0].frequence;
    expect(Math.abs(bin440 - 440 / (frequenceEchantillonnage / n))).toBeLessThanOrEqual(2);
    expect(impulsions[0].amplitude).toBeCloseTo(1, 1);
  });

  it("un silence ne produit AUCUNE impulsion", () => {
    const silence = new Float32Array(1024);
    expect(analyserSpectre(silence)).toHaveLength(0);
  });

  it("borne le nombre de pics demandés", () => {
    const n = 2048;
    const echantillons = new Float32Array(n);
    // Somme de 12 sinus — riche en pics.
    for (let i = 0; i < n; i++) {
      let valeur = 0;
      for (let f = 1; f <= 12; f++) {
        valeur += Math.sin((2 * Math.PI * f * 30 * i) / n) / f;
      }
      echantillons[i] = valeur / 4;
    }
    const impulsions = analyserSpectre(echantillons, { maxPics: 3 });
    expect(impulsions.length).toBeLessThanOrEqual(3);
  });

  it("la fenêtre de Hann est symétrique et vaut 0 aux bords", () => {
    const f = fenetreHann(8);
    expect(f[0]).toBeCloseTo(0, 6);
    expect(f[7]).toBeCloseTo(0, 6);
    expect(f[3]).toBeCloseTo(f[4], 6);
    expect(f[3]).toBeGreaterThan(0.8);
  });
});

describe("versImpulsionsOndes — le spectre entre dans la grille W-DNN", () => {
  it("mappe les fréquences dans la grille sans jamais sortir des bornes", () => {
    const impulsions = [
      { frequence: 5, amplitude: 0.4, phase: 0 },
      { frequence: 1200, amplitude: 0.9, phase: Math.PI / 2 },
    ];
    const ondes = versImpulsionsOndes(impulsions, 128, 128);
    expect(ondes).toHaveLength(2);
    for (const o of ondes) {
      expect(o.x).toBeGreaterThanOrEqual(1);
      expect(o.x).toBeLessThanOrEqual(126);
      expect(o.y).toBeGreaterThanOrEqual(1);
      expect(o.y).toBeLessThanOrEqual(126);
      expect(o.frequence).toBeGreaterThanOrEqual(0.02);
      expect(o.frequence).toBeLessThanOrEqual(0.2);
    }
    // Les graves à gauche, les aigus à droite (mapping perceptuel).
    expect(ondes[0].x).toBeLessThan(ondes[1].x);
  });
});

describe("prosodieDepuisResonance — la voix vibre avec l'essaim", () => {
  it("reste dans des plages parlables quel que soit l'état du champ", () => {
    for (const r of [0, 0.2, 0.5, 1]) {
      for (const e of [0, 0.5, 1]) {
        const p = prosodieDepuisResonance(r, e);
        expect(p.pitch).toBeGreaterThanOrEqual(0.9);
        expect(p.pitch).toBeLessThanOrEqual(1.2);
        expect(p.rate).toBeGreaterThanOrEqual(0.95);
        expect(p.rate).toBeLessThanOrEqual(1.2);
      }
    }
  });

  it("monte le ton quand la résonance monte", () => {
    const bas = prosodieDepuisResonance(0.1, 0.1);
    const haut = prosodieDepuisResonance(0.9, 0.9);
    expect(haut.pitch).toBeGreaterThanOrEqual(bas.pitch);
    expect(haut.rate).toBeGreaterThan(bas.rate);
  });
});

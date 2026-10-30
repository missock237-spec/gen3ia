import { describe, expect, it } from "vitest";

import {
  emettrePaquetsDepuisBandes,
  phaseLocaleRegion,
  propagerOndesInterRegions,
  PAQUETS_MAX,
  GAIN_COUPLAGE_ONDES,
  PLAFOND_MODULATION,
} from "./bus-ondes-regions";

/**
 * BUS D'ONDES INTER-RÉGIONS (it.56) — tests unitaires du canal HORIZONTAL
 * du champ cortical : une région active émet un paquet d'onde
 * [région, fréquence, phase, amplitude], les 1000 régions résonnent
 * (Kuramoto : renfort en phase, annulation en opposition). Module PUR,
 * déterministe : même entrée → même bilan.
 */

function modulationNeuve(): Float32Array {
  return new Float32Array(1000);
}

describe("BusOndesInterRegions (it.56)", () => {
  it("est déterministe : même entrée → même bilan et même modulation", () => {
    const paquets = emettrePaquetsDepuisBandes([0.3, 0, 0.2, 0, 0, 0, 0, 0.1], 7);
    const a = modulationNeuve();
    const b = modulationNeuve();
    const bilanA = propagerOndesInterRegions(a, 7, paquets);
    const bilanB = propagerOndesInterRegions(b, 7, paquets);
    expect(bilanA).toEqual(bilanB);
    expect(Array.from(a)).toEqual(Array.from(b));
    // Les paquets portent le VOCABULAIRE fréquentiel des bandes (les
    // bandes inactives n'émettent pas : [0.3, 0, 0.2, …, 0.1] → bandes 0, 2, 7).
    expect(paquets.length).toBe(3);
    expect(paquets[0].frequence).toBeCloseTo(0.25, 5);
    expect(paquets[1].frequence).toBeCloseTo(0.25 + (2 / 8) * 1.5, 5);
    expect(paquets[2].frequence).toBeCloseTo(0.25 + (7 / 8) * 1.5, 5);
    expect(paquets.every((p) => p.region >= 0 && p.region < 1000)).toBe(true);
    expect(paquets.every((p) => p.amplitude > 0 && p.amplitude <= 1)).toBe(true);
  });

  it("renforce en phase et annule en opposition de phase (physique Kuramoto)", () => {
    const m = modulationNeuve();
    const t = 10;
    // Paquet EN PHASE avec la région 4 : φ = phaseLocale(4, t) → cos δ = 1.
    const enPhase = [{ region: 4, frequence: 0, phase: phaseLocaleRegion(4, t), amplitude: 1 }];
    const avant = m[4];
    propagerOndesInterRegions(m, t, enPhase);
    expect(m[4]).toBeGreaterThan(avant);
    // Paquet EN OPPOSITION : φ + π → cos δ = −1 → modulation tirée vers 0.
    const m2 = modulationNeuve();
    m2[9] = 1.0;
    const opposition = [{ region: 9, frequence: 0, phase: phaseLocaleRegion(9, t) + Math.PI, amplitude: 1 }];
    propagerOndesInterRegions(m2, t, opposition);
    expect(m2[9]).toBeLessThan(1.0);
  });

  it("borne honnêtement : plafond de modulation, paquets plafonnés, bilan réel", () => {
    const m = modulationNeuve();
    m[0] = PLAFOND_MODULATION;
    const paquets = Array.from({ length: PAQUETS_MAX + 20 }, (_, i) => ({
      region: 0,
      frequence: 0.25,
      phase: phaseLocaleRegion(0, i),
      amplitude: 1,
    }));
    const bilan = propagerOndesInterRegions(m, 1, paquets);
    // Plafond respecté (jamais au-delà de 2.0).
    expect(m[0]).toBeLessThanOrEqual(PLAFOND_MODULATION);
    // Paquets en excès rejetés (garde-fou de coût annoncé).
    expect(bilan.paquets).toBe(PAQUETS_MAX);
    // Bilan honnête : l'énergie transportée est réelle, bornée par région.
    expect(bilan.energieTransportee).toBeGreaterThanOrEqual(0);
    expect(bilan.annulations + bilan.renforts).toBeGreaterThan(0);
    // Modulation invalide (NaN) → jamais propagée hors bornes.
    const m2 = modulationNeuve();
    m2[0] = Number.NaN;
    propagerOndesInterRegions(m2, 1, [{ region: 0, frequence: 0.25, phase: 0, amplitude: 1 }]);
    expect(Number.isNaN(m2[0]) || (m2[0] >= 0 && m2[0] <= PLAFOND_MODULATION)).toBe(true);
  });

  it("coût ∝ activité : aucune émission = aucun couplage (repos gratuit)", () => {
    const m = modulationNeuve();
    const avant = Array.from(m);
    // Aucune bande active → aucun paquet → bilan nul, modulation intacte.
    const paquets = emettrePaquetsDepuisBandes([0, 0, 0, 0, 0, 0, 0, 0], 3);
    expect(paquets).toHaveLength(0);
    const bilan = propagerOndesInterRegions(m, 3, paquets);
    expect(bilan).toEqual({ paquets: 0, regionsTouchees: 0, renforts: 0, annulations: 0, energieTransportee: 0 });
    expect(Array.from(m)).toEqual(avant);
    // Le gain reste modeste (couplage doux, jamais d'explosion).
    expect(GAIN_COUPLAGE_ONDES).toBeLessThan(0.2);
  });
});

import { describe, expect, it } from "vitest";

import { BORNES_PHYSIQUES, CONFIGS_EFFORT } from "@/lib/ondes/types";
import { EvolutionOndes } from "@/lib/ondes/evolution";

describe("évolution du champ — optimisation évolutive hebbienne", () => {
  it("le couplage se régule vers la cible d'ordre r", () => {
    const evolution = new EvolutionOndes(0.1, 0.985);
    // Champ trop synchronisé (r = 0.9 ≫ cible 0.35) → le couplage baisse.
    const { couplage: kBas } = evolution.evoluer({ ordreR: 0.9, energie: 0.4, pics: [], pas: 10 });
    expect(kBas).toBeLessThan(0.1);
    // Champ muet (r = 0.05) → le couplage remonte.
    const { couplage: kHaut } = evolution.evoluer({ ordreR: 0.05, energie: 0.4, pics: [], pas: 10 });
    expect(kHaut).toBeGreaterThan(kBas);
    expect(evolution.nbAdaptations).toBeGreaterThan(0);
  });

  it("le couplage et l'amortissement ne franchissent jamais leurs bornes", () => {
    const evolution = new EvolutionOndes(0.05, 0.95);
    for (let i = 0; i < 500; i++) {
      const { couplage, amortissement } = evolution.evoluer({
        ordreR: i % 2 ? 0 : 1,
        energie: i % 2 ? 1 : 0,
        pics: [],
        pas: 1,
      });
      expect(couplage).toBeGreaterThanOrEqual(BORNES_PHYSIQUES.couplageMin);
      expect(couplage).toBeLessThanOrEqual(BORNES_PHYSIQUES.couplageMax);
      expect(amortissement).toBeGreaterThanOrEqual(BORNES_PHYSIQUES.amortissementMin);
      expect(amortissement).toBeLessThanOrEqual(BORNES_PHYSIQUES.amortissementMax);
    }
  });

  it("le renforcement hebbien fait dériver les régions résonantes (borné)", () => {
    const evolution = new EvolutionOndes(CONFIGS_EFFORT.faible.couplage, CONFIGS_EFFORT.faible.amortissement);
    const dim = 128;
    evolution.definirDimension(dim);
    const index = 60 * dim + 60;
    const frequences = new Float32Array(dim * dim).fill(0.1);
    const pics = [{ x: 60, y: 60, amplitude: 3, phase: 0 }];
    for (let i = 0; i < 30; i++) {
      evolution.evoluer({ ordreR: 0.4, energie: 0.4, pics, pas: 1 });
      evolution.appliquer(frequences, dim);
    }
    // La région résonante a dérivé au-dessus de sa valeur initiale, tout
    // en restant dans la bande utile du champ.
    expect(frequences[index]).toBeGreaterThan(0.1);
    expect(frequences[index]).toBeLessThanOrEqual(BORNES_PHYSIQUES.frequenceMax);
    // Une région non résonante n'a pas bougé (pas d'oubli marqué ici).
    expect(frequences[0]).toBeCloseTo(0.1, 5);
  });

  it("l'état d'évolution s'exporte et se restaure (persistence)", () => {
    const evolution = new EvolutionOndes(0.08, 0.98);
    const pics = [{ x: 10, y: 10, amplitude: 2, phase: 0 }];
    for (let i = 0; i < 10; i++) {
      evolution.evoluer({ ordreR: 0.2, energie: 0.3, pics, pas: 4 });
    }
    evolution.noterMot();
    const etat = evolution.exporterEtat();
    expect(etat.pasTotaux).toBe(40);
    expect(etat.motsEmis).toBe(1);
    expect(etat.regions.length).toBeGreaterThan(0);

    const renaissant = new EvolutionOndes(CONFIGS_EFFORT.moyen.couplage, CONFIGS_EFFORT.moyen.amortissement);
    renaissant.importerEtat(etat, 128);
    expect(renaissant.couplageCourant).toBe(etat.couplage);
    expect(renaissant.amortissementCourant).toBe(etat.amortissement);
    expect(renaissant.nbAdaptations).toBe(etat.adaptations);
  });

  it("l'import ignore les régions hors grille", () => {
    const evolution = new EvolutionOndes(0.08, 0.98);
    evolution.importerEtat(
      {
        couplage: 0.1,
        amortissement: 0.98,
        eta: 0.01,
        pasTotaux: 0,
        motsEmis: 0,
        adaptations: 0,
        regions: [
          { i: 100, f: 0.5 },
          { i: 999_999, f: 0.9 }, // hors grille 128² = 16384 → ignoré
        ],
      },
      128,
    );
    const frequences = new Float32Array(128 * 128).fill(0.1);
    evolution.appliquer(frequences, 128);
    expect(frequences[100]).toBeGreaterThan(0.1);
  });
});

import { describe, expect, it } from "vitest";

import { ReseauNeuronalGen3 } from "./network";

/**
 * SANITISATION DE importState (durcissement 2026-10-22) : un état importé
 * (cerveau persisté, export) ne peut plus injecter de synapses invalides —
 * poids non fini (NaN/Infinity : neurone mort, amnésie silencieuse) ou
 * identifiants hors bornes (source/target < 0 ou ≥ size : synapse
 * orpheline). Les synapses saines sont restaurées à l'identique.
 */

describe("ReseauNeuronalGen3.importState — sanitisation des synapses", () => {
  it("rejette les poids non finis et les identifiants hors bornes, garde les synapses saines", () => {
    const reseau = new ReseauNeuronalGen3({ seed: 1, size: 50, density: 0 });

    reseau.importState({
      config: { ...reseau.config, size: 50, density: 0, seed: 9 },
      synapses: [
        [10, 20, 0.5], // saine
        [0, 1, Number.NaN], // poids NaN
        [2, 3, Number.POSITIVE_INFINITY], // poids +∞
        [-1, 4, 0.3], // source négative
        [5, 50, 0.3], // target hors bornes (size = 50 → ids 0..49)
        [50, 6, 0.3], // source hors bornes
        [7, 8, 1.25], // saine (poids plafonné ailleurs, valeur finie valide)
      ],
    });

    expect(reseau.synapses).toHaveLength(2);
    const poids = reseau.synapses.map((s) => s.weight);
    expect(poids).toContain(0.5);
    expect(poids).toContain(1.25);
    for (const s of reseau.synapses) {
      expect(Number.isFinite(s.weight)).toBe(true);
      expect(s.sourceId).toBeGreaterThanOrEqual(0);
      expect(s.sourceId).toBeLessThan(50);
      expect(s.targetId).toBeGreaterThanOrEqual(0);
      expect(s.targetId).toBeLessThan(50);
    }
  });

  it("rejette les entrées malformées sans lever d'exception", () => {
    const reseau = new ReseauNeuronalGen3({ seed: 1, size: 10, density: 0 });

    expect(() =>
      reseau.importState({
        config: { ...reseau.config, size: 10, density: 0, seed: 9 },
        synapses: [
          [0, 1, 0.4],
          [1] as unknown as [number, number, number],
          "fraude" as unknown as [number, number, number],
          [2, 3, 0.6],
        ],
      }),
    ).not.toThrow();

    expect(reseau.synapses).toHaveLength(2);
  });

  it("aller-retour exportState/importState reste fidèle (aucune perte sur un état sain)", () => {
    const source = new ReseauNeuronalGen3({ seed: 42, size: 80, density: 0.15 });
    const cible = new ReseauNeuronalGen3({ seed: 1, size: 80, density: 0 });

    cible.importState(source.exportState());

    expect(cible.synapses.length).toBe(source.synapses.length);
    for (let i = 0; i < source.synapses.length; i++) {
      expect(cible.synapses[i].sourceId).toBe(source.synapses[i].sourceId);
      expect(cible.synapses[i].targetId).toBe(source.synapses[i].targetId);
      expect(cible.synapses[i].weight).toBeCloseTo(source.synapses[i].weight, 12);
    }
  });
});

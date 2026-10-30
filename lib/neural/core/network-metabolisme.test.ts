import { describe, expect, it } from "vitest";

import { ReseauNeuronalGen3 } from "./network";
import { Synapse } from "./synapse";
import { METABOLISME_CUMUL_ZERO } from "./types";

/**
 * MÉTABOLISME CÉRÉBRAL (architecture « cerveau humain », 2026-10-30) :
 *  - ÉQUIVALENCE BIT-À-BIT : la propagation événementielle (index inverse +
 *    neurones dormants sautés) produit EXACTEMENT le même état que le scan
 *    dense historique (spikes, énergies, poids) — seule la stateHistory des
 *    neurones silencieux n'est plus alimentée (non utilisée en production) ;
 *  - COMPTES EXACTS : le métabolisme rapporte le travail RÉEL (évaluations,
 *    repos, spikes, transmissions) et l'économie vs le scan dense ;
 *  - INDEX ROBUSTE : toute mutation topologique (push direct du trainer,
 *    restauration importState) est captée par le test de longueur.
 */

/** Référence DENSE : réplique exacte de l'ancien step() (scan de toutes les synapses). */
function stepDense(
  reseau: ReseauNeuronalGen3,
  externalInputs: Record<number, number>,
  currentTime: number,
): number[] {
  for (const idTexte of Object.keys(externalInputs)) {
    const neurone = reseau.neurones.get(Number(idTexte));
    if (neurone) neurone.receiveInput(externalInputs[Number(idTexte)]);
  }
  const spikedNeurones: number[] = [];
  for (const [, neurone] of reseau.neurones) {
    if (neurone.updateState(currentTime)) spikedNeurones.push(neurone.id);
  }
  const spikedSet = new Set(spikedNeurones);
  for (const synapse of reseau.synapses) {
    if (spikedSet.has(synapse.sourceId)) {
      const target = reseau.neurones.get(synapse.targetId);
      if (!target) continue;
      target.receiveInput(synapse.weight);
      synapse.lastActivation = currentTime;
      const timeDiff = currentTime - target.lastSpikeTime;
      if (timeDiff < reseau.config.plasticityWindow) {
        synapse.weight = Math.min(1.0, synapse.weight + reseau.learningRate);
      }
    }
  }
  return spikedNeurones;
}

describe("métabolisme cérébral — équivalence dense ↔ événementiel", () => {
  it("mêmes spikes, mêmes énergies, mêmes poids sur 12 pas (3 seeds, entrées variables)", () => {
    for (const seed of [1, 42, 777]) {
      const taille = 60;
      const evenementiel = new ReseauNeuronalGen3({ seed, size: taille, density: 0.15 });
      const dense = new ReseauNeuronalGen3({ seed, size: taille, density: 0.15 });

      // Même câblage initial (déterminisme du seed — testé ailleurs) : on
      // force néanmoins l'égalité stricte des poids de départ.
      expect(dense.synapses.length).toBe(evenementiel.synapses.length);
      for (let i = 0; i < dense.synapses.length; i++) {
        dense.synapses[i].weight = evenementiel.synapses[i].weight;
      }

      // Scénario d'activité : injection forte → propagation → repos relatif.
      const entrees: Record<number, Record<number, number>> = {
        1: { 3: 2.0, 17: 1.4 },
        2: {},
        3: { 5: 0.9 },
        4: {},
        5: { 3: 1.8, 40: 0.6 },
        6: { 11: 1.1 },
        7: {},
        8: { 9: 1.5, 21: 0.7 },
        9: {},
        10: { 44: 2.2 },
        11: { 5: 1.2 },
        12: {},
      };

      for (let pas = 1; pas <= 12; pas++) {
        const spikE = evenementiel.step(entrees[pas] ?? {}, pas);
        const spikD = stepDense(dense, entrees[pas] ?? {}, pas);
        expect(spikE).toEqual(spikD);

        // Énergies post-pas identiques (bit-exact, pas de toBeCloseTo).
        for (const [id, neurone] of evenementiel.neurones) {
          const miroir = dense.neurones.get(id);
          expect(miroir).toBeDefined();
          expect(neurone.energy).toBe(miroir!.energy);
          expect(neurone.lastSpikeTime).toBe(miroir!.lastSpikeTime);
        }
        // Poids synaptiques identiques après plasticité.
        for (let i = 0; i < evenementiel.synapses.length; i++) {
          expect(evenementiel.synapses[i].weight).toBe(dense.synapses[i].weight);
          expect(evenementiel.synapses[i].lastActivation).toBe(dense.synapses[i].lastActivation);
        }
      }
    }
  });

  it("le pas SANS entrée sur réseau frais ne paie RIEN (100 % au repos)", () => {
    const reseau = new ReseauNeuronalGen3({ seed: 42, size: 140, density: 0.1 });
    const spiked = reseau.step({}, 1);
    expect(spiked).toEqual([]);
    const pas = reseau.metabolismeDernierPas;
    expect(pas.neuronesEvalues).toBe(0);
    expect(pas.neuronesReposes).toBe(140);
    expect(pas.spikes).toBe(0);
    expect(pas.transmissions).toBe(0);
    expect(pas.synapsesDenses).toBe(reseau.synapses.length);
    // Économie intégrale : les transmissions évitées = tout le scan dense.
    expect(reseau.metabolismeCumul.transmissionsEvitees).toBe(reseau.synapses.length);
  });

  it("comptes EXACTS sur réseau artisanal (densité 0 + synapses posées à la main)", () => {
    const reseau = new ReseauNeuronalGen3({ seed: 1, size: 3, density: 0 });
    const s01 = new Synapse(0, 1, 0.9);
    const s02 = new Synapse(0, 2, 0.4);
    reseau.synapses.push(s01, s02);

    // t=5 : hors fenêtre de plasticité (5 - 0 ≥ 2) — comptes purs.
    const spiked = reseau.step({ 0: 2.0 }, 5);
    expect(spiked).toEqual([0]);
    expect(reseau.metabolismeDernierPas).toEqual({
      neuronesEvalues: 1,
      neuronesReposes: 2,
      spikes: 1,
      transmissions: 2, // 0→1 et 0→2 (seules les synapses du spiké)
      synapsesDenses: 2,
    });
    // Cibles chargées, plasticté hors fenêtre : poids inchangés.
    expect(reseau.neurones.get(1)?.energy).toBe(0.9);
    expect(reseau.neurones.get(2)?.energy).toBe(0.4);
    expect(s01.weight).toBe(0.9);
    expect(s02.weight).toBe(0.4);

    // t=6 : repos pour 0 (énergie nulle), évaluation pour 1 et 2 (résidus).
    reseau.step({}, 6);
    expect(reseau.metabolismeDernierPas).toEqual({
      neuronesEvalues: 2,
      neuronesReposes: 1,
      spikes: 0,
      transmissions: 0,
      synapsesDenses: 2,
    });

    // Cumul sur les 2 pas : transmissions évitées = 2 (scan dense 2+2, réel 2+0).
    expect(reseau.metabolismeCumul.pas).toBe(2);
    expect(reseau.metabolismeCumul.neuronesEvalues).toBe(3);
    expect(reseau.metabolismeCumul.neuronesReposes).toBe(3);
    expect(reseau.metabolismeCumul.spikes).toBe(1);
    expect(reseau.metabolismeCumul.transmissions).toBe(2);
    expect(reseau.metabolismeCumul.transmissionsEvitees).toBe(2);
  });

  it("l'index suit les PUSHES directs de synapses (pattern trainer/runtime)", () => {
    const reseau = new ReseauNeuronalGen3({ seed: 1, size: 4, density: 0 });
    // Premier pas : 0 spique mais n'a AUCUNE synapse sortante → 0 transmission.
    reseau.step({ 0: 2.0 }, 5);
    expect(reseau.metabolismeDernierPas.transmissions).toBe(0);

    // Push direct (hors constructeur) : le trainer/runtime font exactement ça.
    reseau.synapses.push(new Synapse(0, 3, 0.95));

    // Deuxième pas : la nouvelle synapse DOIT transmettre (index reconstruit).
    const spiked = reseau.step({ 0: 2.0 }, 6);
    expect(spiked).toEqual([0]);
    expect(reseau.metabolismeDernierPas.transmissions).toBe(1);
    expect(reseau.neurones.get(3)?.energy).toBeCloseTo(0.95, 12);
  });

  it("importState repart sur un métabolisme neuf (et l'index suit la topologie restaurée)", () => {
    const source = new ReseauNeuronalGen3({ seed: 42, size: 50, density: 0.1 });
    source.step({ 3: 2.0 }, 1);
    expect(source.metabolismeCumul.pas).toBe(1);

    const clone = new ReseauNeuronalGen3({ seed: 999 });
    clone.importState(source.exportState());
    expect(clone.getMetabolisme()).toEqual(METABOLISME_CUMUL_ZERO);

    // Le cerveau restauré fonctionne (topologie restaurée → transmissions).
    const idSource = clone.synapses[0].sourceId;
    const spiked = clone.step({ [idSource]: 2.0 }, 5);
    expect(spiked.length).toBeGreaterThan(0);
    expect(clone.metabolismeCumul.pas).toBe(1);
    expect(clone.metabolismeCumul.transmissions).toBeGreaterThan(0);
  });
});

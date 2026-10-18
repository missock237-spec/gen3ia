import { describe, expect, it } from "vitest";

import { ReseauNeuronalGen3 } from "./network";
import { Neurone } from "./neuron";
import { Synapse } from "./synapse";

/**
 * RÉSEAU NEURONAL — tests unitaires du portage :
 *  - déterminisme du seed (deux réseaux identiques → synapses identiques) ;
 *  - spike après injection au-dessus du seuil ;
 *  - décroissance naturelle sans spike ;
 *  - plasticité synaptique (renforcement dans la fenêtre, hors fenêtre : rien).
 */

describe("ReseauNeuronalGen3", () => {
  it("deux réseaux de même seed produisent des synapses strictement identiques", () => {
    const a = new ReseauNeuronalGen3({ seed: 42 });
    const b = new ReseauNeuronalGen3({ seed: 42 });

    expect(a.synapses.length).toBe(b.synapses.length);
    expect(a.synapses.length).toBeGreaterThan(0);
    for (let i = 0; i < a.synapses.length; i++) {
      expect(a.synapses[i].sourceId).toBe(b.synapses[i].sourceId);
      expect(a.synapses[i].targetId).toBe(b.synapses[i].targetId);
      expect(a.synapses[i].weight).toBeCloseTo(b.synapses[i].weight, 12);
    }

    // Et un autre seed produit un câblage différent.
    const c = new ReseauNeuronalGen3({ seed: 43 });
    const identique =
      c.synapses.length === a.synapses.length &&
      c.synapses.every(
        (s, i) =>
          s.sourceId === a.synapses[i].sourceId &&
          s.targetId === a.synapses[i].targetId &&
          s.weight === a.synapses[i].weight,
      );
    expect(identique).toBe(false);
  });

  it("injecte au-dessus du seuil → le neurone spike et se réinitialise", () => {
    const reseau = new ReseauNeuronalGen3({ seed: 1, density: 0 });
    // Injection exactement au seuil : 1.2 ≥ 1.0 après décroissance ? Non :
    // 1.2 × 0.9 = 1.08 ≥ 1.0 → spike. On vérifie aussi un injection sous
    // le seuil post-décroissance (voir test suivant).
    const spiked = reseau.step({ 5: 1.2 }, 1);
    expect(spiked).toContain(5);
    expect(reseau.neurones.get(5)?.energy).toBe(0);
    expect(reseau.neurones.get(5)?.lastSpikeTime).toBe(1);
  });

  it("décroissance naturelle : pas de spike sous le seuil, énergie dissipée", () => {
    const reseau = new ReseauNeuronalGen3({ seed: 1, density: 0 });
    const spiked = reseau.step({ 7: 0.5 }, 1);

    expect(spiked).not.toContain(7);
    // 0.5 × (1 - 0.1) = 0.45 après dissipation naturelle.
    expect(reseau.neurones.get(7)?.energy).toBeCloseTo(0.45, 12);
    expect(reseau.neurones.get(7)?.lastSpikeTime).toBe(0);
  });

  it("plasticité : renforce la synapse quand la cible a spike récemment", () => {
    const reseau = new ReseauNeuronalGen3({ seed: 1, density: 0 });
    const synapse = new Synapse(0, 1, 0.3);
    reseau.synapses.push(synapse);

    // t=1 : la cible (1) spike — lastSpikeTime = 1.
    let spiked = reseau.step({ 1: 2.0 }, 1);
    expect(spiked).toContain(1);

    // t=2 : la source (0) spike → transmission 0.3 vers la cible ;
    // timeDiff = 2 - 1 = 1 < 2.0 (fenêtre) → renforcement +0.05.
    spiked = reseau.step({ 0: 2.0 }, 2);
    expect(spiked).toContain(0);
    expect(synapse.weight).toBeCloseTo(0.35, 12);
    // La cible a reçu le poids transmis (énergie accumulée post-update).
    expect(reseau.neurones.get(1)?.energy).toBeCloseTo(0.3, 12);
  });

  it("plasticité : aucune modification hors de la fenêtre", () => {
    const reseau = new ReseauNeuronalGen3({ seed: 1, density: 0 });
    const synapse = new Synapse(0, 1, 0.3);
    reseau.synapses.push(synapse);

    // La cible n'a jamais spike (lastSpikeTime = 0) : à t=5, timeDiff = 5 ≥ 2.
    const spiked = reseau.step({ 0: 2.0 }, 5);
    expect(spiked).toContain(0);
    expect(synapse.weight).toBeCloseTo(0.3, 12);
  });

  it("getStats : compteurs, poids et histogramme cohérents", () => {
    const reseau = new ReseauNeuronalGen3({ seed: 42, density: 0.1 });
    const stats = reseau.getStats();

    expect(stats.nbNeurones).toBe(100);
    expect(stats.nbSynapses).toBe(reseau.synapses.length);
    expect(stats.poidsMin).toBeGreaterThanOrEqual(0.1);
    expect(stats.poidsMax).toBeLessThanOrEqual(0.5);
    expect(stats.poidsMoyen).toBeGreaterThan(0);
    // La somme de l'histogramme restitue le nombre total de synapses.
    expect(stats.histogramme.reduce((a, b) => a + b, 0)).toBe(
      stats.nbSynapses,
    );
    expect(stats.histogramme.length).toBe(10);
  });

  it("exportState / importState : le câblage survit à un aller-retour", () => {
    const a = new ReseauNeuronalGen3({ seed: 42, density: 0.1 });
    const etat = a.exportState();

    const b = new ReseauNeuronalGen3({ seed: 999 });
    b.importState(etat);

    expect(b.synapses.length).toBe(a.synapses.length);
    for (let i = 0; i < a.synapses.length; i++) {
      expect(b.synapses[i].sourceId).toBe(a.synapses[i].sourceId);
      expect(b.synapses[i].targetId).toBe(a.synapses[i].targetId);
      expect(b.synapses[i].weight).toBeCloseTo(a.synapses[i].weight, 12);
    }
    // Le réseau importé garde la taille de la configuration importée.
    expect(b.neurones.size).toBe(etat.config.size);
  });

  it("les poids initiaux restent dans [0.1, 0.5] et src ≠ tgt", () => {
    const reseau = new ReseauNeuronalGen3({ seed: 42, density: 0.3 });
    for (const s of reseau.synapses) {
      expect(s.sourceId).not.toBe(s.targetId);
      expect(s.weight).toBeGreaterThanOrEqual(0.1);
      expect(s.weight).toBeLessThanOrEqual(0.5);
    }
  });
});

describe("Neurone", () => {
  it("historique d'état borné à 50 snapshots", () => {
    const neurone = new Neurone(0);
    for (let t = 1; t <= 80; t++) {
      neurone.updateState(t);
    }
    expect(neurone.stateHistory.length).toBe(50);
  });
});

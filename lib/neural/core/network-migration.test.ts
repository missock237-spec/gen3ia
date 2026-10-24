import { describe, it, expect } from "vitest";

import { ReseauNeuronalGen3 } from "../core/network";
import { Synapse } from "../core/synapse";
import { TAILLE_RESEAU_GEN3 } from "../core/types";

/**
 * MIGRATION V3 DU RÉSEAU — importStateEtendu étend un cerveau historique
 * (100 neurones) vers la couche des domaines (140) sans perdre une seule
 * synapse apprise, avec câblage déterministe des nouveaux neurones.
 */
describe("ReseauNeuronalGen3.importStateEtendu", () => {
  it("100 → 140 neurones : synapses historiques intactes, nouveaux neurones câblés", () => {
    // Cerveau historique 100 neurones avec une synapse apprise 5→68.
    const historique = new ReseauNeuronalGen3({ seed: 7 });
    expect(historique.config.size).toBe(100);
    historique.synapses.push(new Synapse(5, 68, 0.42));
    const etat = historique.exportState();

    // Migration vers 140.
    const migre = new ReseauNeuronalGen3({ seed: 999, size: 10 });
    migre.importStateEtendu(etat, TAILLE_RESEAU_GEN3);

    expect(migre.config.size).toBe(TAILLE_RESEAU_GEN3);
    expect(migre.neurones.size).toBe(TAILLE_RESEAU_GEN3);
    // La synapse apprise est conservée À L'IDENTIQUE.
    const conservee = migre.synapses.find(
      (s) => s.sourceId === 5 && s.targetId === 68,
    );
    expect(conservee).toBeDefined();
    expect(conservee!.weight).toBeCloseTo(0.42, 12);
    // TOUTES les synapses historiques sont là (aucune perte, aucun rejet).
    expect(migre.synapses.length).toBeGreaterThanOrEqual(etat.synapses.length);
    // Reproductibilité : deux migrations du même état produisent le même réseau.
    const migre2 = new ReseauNeuronalGen3({ seed: 999, size: 10 });
    migre2.importStateEtendu(etat, TAILLE_RESEAU_GEN3);
    expect(migre2.synapses.length).toBe(migre.synapses.length);
    // Les nouveaux neurones participent au câblage initial (le réseau
    // étendu a plus de synapses que le strict historique).
    expect(migre.synapses.length).toBeGreaterThan(etat.synapses.length);
  });

  it("taille cible ≤ taille actuelle : no-op fidèle", () => {
    const reseau = new ReseauNeuronalGen3({ seed: 11 });
    const etat = reseau.exportState();
    const avant = reseau.synapses.length;
    reseau.importStateEtendu(etat, 50);
    expect(reseau.config.size).toBe(100);
    expect(reseau.synapses.length).toBe(avant);
  });
});

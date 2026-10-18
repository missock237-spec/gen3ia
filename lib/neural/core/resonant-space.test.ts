import { describe, expect, it } from "vitest";

import { ReseauNeuronalGen3 } from "./network";
import { EspaceFiltreResonant } from "./resonant-space";

/**
 * ESPACE D'ENTRÉE-SORTIE RÉSONANT — tests unitaires :
 *  - readResonance : 0, 0.5, 1.0 selon les spikes du pool ;
 *  - canal inconnu → 0 ;
 *  - injectSignal : conversion canal → énergie neuronale.
 */

describe("EspaceFiltreResonant", () => {
  it("readResonance : 0 sans spike, 0.5 pour un neurone sur deux, 1.0 complet", () => {
    const espace = new EspaceFiltreResonant();
    espace.registerOutputPool("GENERER_AUDIO", [42, 43]);

    expect(espace.readResonance([], "GENERER_AUDIO")).toBe(0);
    expect(espace.readResonance([42], "GENERER_AUDIO")).toBe(0.5);
    expect(espace.readResonance([42, 43], "GENERER_AUDIO")).toBe(1);
    expect(espace.readResonance([42, 43, 44, 45], "GENERER_AUDIO")).toBe(1);
  });

  it("readResonance : canal inconnu → 0", () => {
    const espace = new EspaceFiltreResonant();
    espace.registerOutputPool("GENERER_IMAGE", [46, 47]);

    expect(espace.readResonance([46, 47], "CANAL_INCONNU")).toBe(0);
    expect(espace.readResonance([46, 47], "GENERER_AUDIO")).toBe(0);
  });

  it("injectSignal : chaque neurone du pool d'entrée reçoit l'intensité", () => {
    const espace = new EspaceFiltreResonant();
    espace.registerInputPool("utilisateur_in", [38, 39]);
    const reseau = new ReseauNeuronalGen3({ seed: 1, density: 0 });

    espace.injectSignal(reseau, "utilisateur_in", 1.5);

    expect(reseau.neurones.get(38)?.energy).toBeCloseTo(1.5, 12);
    expect(reseau.neurones.get(39)?.energy).toBeCloseTo(1.5, 12);
    // Les autres neurones ne sont pas stimulés.
    expect(reseau.neurones.get(37)?.energy).toBe(0);
    expect(reseau.neurones.get(40)?.energy).toBe(0);
  });

  it("injectSignal : canal inconnu → aucune injection", () => {
    const espace = new EspaceFiltreResonant();
    const reseau = new ReseauNeuronalGen3({ seed: 1, density: 0 });

    espace.injectSignal(reseau, "canal_absent", 10);

    for (const neurone of reseau.neurones.values()) {
      expect(neurone.energy).toBe(0);
    }
  });
});

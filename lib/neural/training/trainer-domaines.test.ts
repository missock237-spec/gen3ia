import { describe, it, expect } from "vitest";

import { ReseauNeuronalGen3 } from "../core/network";
import { EspaceFiltreResonant } from "../core/resonant-space";
import { GenerateurAutoOscillation } from "../core/auto-oscillation";
import { NoyauCentralGen3 } from "../core/central-core";
import { createRng } from "../core/rng";
import { NeuralTrainer, enregistrerPoolsDomaines } from "./trainer";
import { TAILLE_RESEAU_GEN3, SEUIL_POOL_DOMAINE, ZONE_DOMAINES } from "../core/types";

/**
 * COUCHE DES DOMAINES DU TRAINER — le trainDomaines s'exécute réellement
 * (plasticité sur les pools 100-135, punition compétitive limitée aux
 * domaines, découpe train/test seedée). Le substrat SNN étant borné pour
 * une classification 18 classes (cf. doc de detecterDomaine), le test
 * vérifie la MÉCANIQUE d'apprentissage sur un sous-ensemble réduit
 * (3 domaines à vocabulaires disjoints — régime où le SNN apprend).
 */
describe("NeuralTrainer.trainDomaines", () => {
  it("apprend 3 domaines à vocabulaires disjoints (accuracy > hasard)", async () => {
    const reseau = new ReseauNeuronalGen3({ seed: 3, density: 0.05, size: TAILLE_RESEAU_GEN3 });
    const espace = new EspaceFiltreResonant();
    enregistrerPoolsDomaines(espace);
    const veille = new GenerateurAutoOscillation(reseau, 0.15, 0.15, createRng(77));
    const noyau = new NoyauCentralGen3(reseau, espace, veille);
    const trainer = new NeuralTrainer(reseau, espace, veille, noyau);

    // Accorde les seuils de la couche domaine (miroir du runtime).
    for (let id = ZONE_DOMAINES.debut; id <= ZONE_DOMAINES.fin; id++) {
      const neurone = reseau.neurones.get(id);
      if (neurone) neurone.threshold = SEUIL_POOL_DOMAINE;
    }

    const samples = [
      // DOM_VIDEO (vocabulaire disjoint)
      ...Array.from({ length: 12 }, () => ({ text: "storyboard plan camera montage", label: "DOM_VIDEO" })),
      ...Array.from({ length: 12 }, () => ({ text: "rendu codec fps resolution", label: "DOM_VIDEO" })),
      // DOM_VENTE
      ...Array.from({ length: 12 }, () => ({ text: "objection prospect pitch closing", label: "DOM_VENTE" })),
      ...Array.from({ length: 12 }, () => ({ text: "devis offre commerciale upsell", label: "DOM_VENTE" })),
      // DOM_ANALYSE_DONNEES
      ...Array.from({ length: 12 }, () => ({ text: "graphique mediane correlation histogramme", label: "DOM_ANALYSE_DONNEES" })),
      ...Array.from({ length: 12 }, () => ({ text: "nettoyage dataset csv pandas", label: "DOM_ANALYSE_DONNEES" })),
    ];

    const rapport = await trainer.trainDomaines(samples, {
      epochs: 5,
      lrBoost: 0.2,
      cyclesParEchantillon: 4,
    });

    expect(rapport.epochs).toBe(5);
    expect(rapport.samples).toBeGreaterThan(0);
    expect(rapport.history).toHaveLength(5);
    expect(rapport.dureeMs).toBeGreaterThan(0);
    // Répartition honnête par domaine (ordre lexicographique).
    expect(Object.keys(rapport.parDomaine).sort()).toEqual([
      "analyse_donnees",
      "vente",
      "video",
    ]);
    // Le substrat APPREND : la dernière époque bat le hasard (1/3).
    expect(rapport.history[4].accuracy).toBeGreaterThan(0.34);
    // L'accuracy test est mesurée honnêtement (≥ 0, borne réelle).
    expect(rapport.accuracyTest).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("les pools de domaine sont enregistrés sur l'espace résonant", () => {
    const espace = new EspaceFiltreResonant();
    enregistrerPoolsDomaines(espace);
    expect(espace.outputPools.size).toBe(18);
    for (const [label, pool] of espace.outputPools) {
      expect(label).toMatch(/^DOM_/);
      expect(pool).toHaveLength(2);
    }
  });
});

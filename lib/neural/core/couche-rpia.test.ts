import { describe, expect, it } from "vitest";

import { ReseauNeuronalGen3 } from "@/lib/neural/core/network";
import {
  CoucheOndesNeuronales,
  entrainerCerveauParResonance,
} from "@/lib/neural/core/couche-rpia";

describe("couche d'ondes neuronales RPIA (pont résonance → cerveau)", () => {
  it("un nœud d'onde par neurone : taille exacte et correspondance d'index", () => {
    const couche = new CoucheOndesNeuronales(100);
    expect(couche.taille).toBe(100);
    expect(couche.noeuds()).toHaveLength(100);
    // Le cerveau de référence fait 100 neurones (NEURAL_CONFIG_DEFAUTS).
    const reseau = new ReseauNeuronalGen3();
    expect(reseau.neurones.size).toBe(couche.taille);
  });

  it("l'entraînement RPIA converge réellement vers l'onde cible du texte", () => {
    const couche = new CoucheOndesNeuronales(256);
    const rapport = couche.entrainerVersTexte("rédiger un rapport d'analyse de données", 200);
    expect(rapport.epoques).toBe(200);
    expect(rapport.erreurFinale).toBeLessThan(rapport.erreurInitiale);
    expect(rapport.convergence).toBe(true);
  });

  it("énergies de résonance : bornées [0, 0.5], homéostasie préservée, motif dépendant du texte", () => {
    const couche = new CoucheOndesNeuronales(100);
    couche.entrainerVersTexte("générer une image photoréaliste", 150);

    const energies = couche.energiesResonance();
    const valeurs = Object.values(energies);
    expect(valeurs.length).toBeGreaterThan(0);
    for (const e of valeurs) {
      expect(e).toBeGreaterThan(0);
      expect(e).toBeLessThanOrEqual(0.5);
    }
    // Homéostasie du noyau central : alerte si moyenne > 0.75 — la couche
    // n'atteint JAMAIS ce niveau (moyenne ≤ 0.5 par construction).
    const moyenne = valeurs.reduce((s, v) => s + v, 0) / valeurs.length;
    expect(moyenne).toBeLessThan(0.75);

    // Deux textes différents → deux motifs d'énergie distincts
    // (le cerveau « ressent » la différence avant même de décoder).
    const autre = new CoucheOndesNeuronales(100);
    autre.entrainerVersTexte("répondre à un questionnaire utilisateur", 150);
    const e1 = couche.energiesResonance();
    const e2 = autre.energiesResonance();
    let distance = 0;
    for (let i = 0; i < 100; i++) distance += Math.abs((e1[i] ?? 0) - (e2[i] ?? 0));
    expect(distance).toBeGreaterThan(1);
  });

  it("LE PONT : les énergies entraînées injectées dans reseau.step provoquent des spikes réels", () => {
    const reseau = new ReseauNeuronalGen3();
    const { energies } = entrainerCerveauParResonance(reseau.neurones.size, "analyser des données", {
      epoques: 150,
    });

    // Injection sur plusieurs cycles : l'énergie s'accumule contre la
    // décroissance (threshold 1.0, énergie ~0.2/cycle → pic vers le
    // cycle 8). La résonance est plus douce qu'un choc, mais franchit
    // réellement le seuil du neurone.
    const spikesParCycle: number[] = [];
    for (let t = 1; t <= 10; t++) {
      const spikes = reseau.step(energies, t);
      spikesParCycle.push(spikes.length);
    }
    const totalSpikes = spikesParCycle.reduce((s, v) => s + v, 0);
    expect(totalSpikes).toBeGreaterThan(0);

    // Le motif injecté EST celui de l'entraînement : les énergies ne sont
    // pas uniformes (des neurones résonnent plus fort que d'autres).
    const valeurs = Object.values(energies);
    const max = Math.max(...valeurs);
    const min = Math.min(...valeurs);
    expect(max - min).toBeGreaterThan(0.01);
  });

  it("persistance : export/import de l'état appris (JSON-safe, reprise sans ré-entraînement)", () => {
    const couche = new CoucheOndesNeuronales(64);
    couche.entrainerVersTexte("contrôle de cohérence de données", 50);
    const etat = couche.exporterEtat();

    // JSON-safe : sérialisation/désérialisation réelle (poids arrondis
    // 1e-6 → reprise quasi identique, précision 1e-3 vérifiée honnêtement).
    const copie = new CoucheOndesNeuronales(64);
    copie.importerEtat(JSON.parse(JSON.stringify(etat)));

    const cible = couche.cibleDepuisTexte("contrôle de cohérence de données");
    const erreurSource = couche.entraineurErreurCourante(cible);
    const erreurCopie = copie.entraineurErreurCourante(cible);
    expect(erreurCopie).toBeCloseTo(erreurSource, 3);
  });

  it("refuse un checkpoint ondulatoire corrompu sans altérer l'état courant", () => {
    const couche = new CoucheOndesNeuronales(8);
    couche.resonnerVersTexte("checkpoint valide", 4);
    const avant = couche.exporterEtat();

    const poidsNan = avant.poids.slice();
    poidsNan[2] = Number.NaN;
    expect(() => couche.importerEtat({ ...avant, poids: poidsNan })).toThrow(/Poids RPIA non fini/);
    expect(couche.exporterEtat()).toEqual(avant);

    expect(() => couche.importerEtat({ ...avant, pasTotaux: Number.NaN })).toThrow(
      /Compteur de pas invalide/,
    );
    expect(couche.exporterEtat()).toEqual(avant);
  });

  it("entrées invalides refusées (taille, texte vide, état incompatible)", () => {
    expect(() => new CoucheOndesNeuronales(0)).toThrow(/Taille de couche invalide/);
    expect(() => new CoucheOndesNeuronales(5000)).toThrow(/Taille de couche invalide/);
    const couche = new CoucheOndesNeuronales(32);
    expect(() => couche.entrainerVersTexte("", 10)).toThrow(/Texte de requête vide/);
    expect(() => couche.importerEtat({ taille: 64, poids: new Array(256).fill(0) })).toThrow(
      /incompatible/,
    );
  });
});

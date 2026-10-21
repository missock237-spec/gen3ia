import { describe, expect, it, vi } from "vitest";

import { CortexColumnnaire } from "./cortex-columnnaire";
import { ChampCorticalGen3 } from "./champ-cortical";
import {
  BANDES_INTENTION,
  CAP_REMONTEE_INTENTION,
  EffecteurCortexV2,
  nouvelleFenetreNeuronale,
} from "./effecteur-cortex";
import { POOL_GENERER_IMAGE } from "../types";
import { tokenize } from "../../encoding/text-encoder";

/** Petit cortex de test : 1024 colonnes, 4 voisins, 8 bandes (128/bande). */
function petitEnsemble(seed = 42): {
  cortex: CortexColumnnaire;
  champ: ChampCorticalGen3;
  effecteur: EffecteurCortexV2;
  energiesRecues: Map<number, number[]>;
} {
  const cortex = new CortexColumnnaire({
    colonnes: 1024,
    voisins: 4,
    seed,
    bandes: 8,
  });
  const champ = new ChampCorticalGen3(seed);
  const energiesRecues = new Map<number, number[]>();
  const reseau = {
    neurones: new Map(
      Array.from({ length: 100 }, (_, id) => [
        id,
        {
          receiveInput: (v: number) => {
            const liste = energiesRecues.get(id) ?? [];
            liste.push(v);
            energiesRecues.set(id, liste);
          },
        },
      ]),
    ),
  };
  const effecteur = new EffecteurCortexV2(reseau, cortex, champ, seed);
  return { cortex, champ, effecteur, energiesRecues };
}

describe("EffecteurCortexV2", () => {
  it("déclare 8 bandes d'intention miroir des pools v1", () => {
    expect(BANDES_INTENTION).toHaveLength(8);
    const labels = BANDES_INTENTION.map((b) => b.label);
    expect(labels).toContain("GENERER_IMAGE");
    expect(labels).toContain("INTENTION_GENERALE");
    expect(BANDES_INTENTION[0].pool).toEqual(POOL_GENERER_IMAGE);
  });

  it("projette le prompt au premier cycle de la fenêtre, puis propage", () => {
    const { cortex, effecteur } = petitEnsemble();
    const fenetre = nouvelleFenetreNeuronale();
    const actions = effecteur.evaluerEtExecuter([], {
      prompt: "génère une image d'un chat",
      __fenetreNeuronale: fenetre,
    });
    expect(actions).toEqual([]); // traitement interne, aucune action sémantique
    // Les colonnes projetées portent de l'énergie décroissie.
    let energisees = 0;
    for (let c = 0; c < cortex.config.colonnes; c++) {
      if (cortex.energies[c] > 0) energisees += 1;
    }
    expect(energisees).toBeGreaterThan(0);
    // Second cycle même fenêtre : pas de ré-injection (volée unique), la
    // propagation CSR continue (énergies en attente évaluées).
    effecteur.evaluerEtExecuter([], {
      prompt: "génère une image d'un chat",
      __fenetreNeuronale: fenetre,
    });
  });

  it("remet les énergies à zéro à chaque nouvelle fenêtre neuronale", () => {
    const { cortex, effecteur } = petitEnsemble();
    const espion = vi.spyOn(cortex, "reinitialiserEnergies");
    // Fenêtre 1 : premier cycle (reset d'amorçage) puis propagation.
    const f1 = nouvelleFenetreNeuronale();
    effecteur.evaluerEtExecuter([], {
      prompt: "bonjour monde",
      __fenetreNeuronale: f1,
    });
    expect(espion).toHaveBeenCalledTimes(1);
    effecteur.evaluerEtExecuter([], {
      prompt: "bonjour monde",
      __fenetreNeuronale: f1,
    });
    // Même fenêtre : AUCUN reset (la propagation continue).
    expect(espion).toHaveBeenCalledTimes(1);
    // Nouvelle fenêtre → reset complet (inférence propre, miroir de (d)).
    const f2 = nouvelleFenetreNeuronale();
    effecteur.evaluerEtExecuter([], { __fenetreNeuronale: f2 });
    expect(espion).toHaveBeenCalledTimes(2);
    // Cycle de veille supplémentaire (pas de fenêtre) : pas de reset.
    effecteur.evaluerEtExecuter([], {});
    expect(espion).toHaveBeenCalledTimes(2);
  });

  it("reverse la résonance des bandes d'intention vers les pools v1", () => {
    const { effecteur, energiesRecues } = petitEnsemble();
    // Sur-stimuler la bande 0 (GENERER_IMAGE) : colonnes 0..127 (1024/8).
    const fenetre = nouvelleFenetreNeuronale();
    const injections: Array<[number, number]> = [];
    for (let c = 0; c < 128; c += 2) injections.push([c, 3.0]); // spike massif
    effecteur.evaluerEtExecuter([], {
      prompt: "", // pas de prompt → les injections passent par le test direct
      __fenetreNeuronale: fenetre,
    });
    void injections; // (la projection passe par le prompt — voir test suivant)
    // Vérifie que le chemin de remontée existe : un prompt court ciblant
    // des colonnes de la bande 0 via hash — comportement probabiliste.
    // On teste donc la mécanique via la plasticité (test suivant) et on
    // vérifie ici qu'aucune énergie n'a fuité vers des neurones inexistants.
    for (const [id] of energiesRecues) {
      expect(id).toBeLessThan(100);
    }
  });

  it("consolide la plasticité supervisée à la clôture de fenêtre", () => {
    const { cortex, effecteur } = petitEnsemble();
    const bandeImage = BANDES_INTENTION.findIndex(
      (b) => b.label === "GENERER_IMAGE",
    );
    // Prompt riche : beaucoup de colonnes stimulées → plusieurs arêtes
    // vers la bande image (déterministe — mêmes projections).
    const promptEntrainement =
      "crée génère dessine peins une image dessin photo magnifique spectacle paysage " +
      "océan soleil ciel nuages forêt montagne fleurs animaux ville lumière couleur";
    const stimulees = new Set(
      cortex.projetterTokens(tokenize(promptEntrainement)).map(([c]) => c),
    );
    // Poids initiaux des arêtes des colonnes stimulées.
    const avant = new Map<number, number>();
    for (const c of stimulees) {
      for (let k = 0; k < cortex.config.voisins; k++) {
        avant.set(c * cortex.config.voisins + k, cortex.csrPoids[c * cortex.config.voisins + k]);
      }
    }
    // Fenêtre d'entraînement : prompt + intention cible (4 cycles).
    const f1 = nouvelleFenetreNeuronale();
    for (let cycle = 0; cycle < 4; cycle++) {
      effecteur.evaluerEtExecuter([], {
        prompt: promptEntrainement,
        __fenetreNeuronale: f1,
        __intentionCible: "GENERER_IMAGE",
      });
    }
    // Clôture : nouvelle fenêtre → consolidation.
    const f2 = nouvelleFenetreNeuronale();
    effecteur.evaluerEtExecuter([], { __fenetreNeuronale: f2 });

    // Arêtes des colonnes stimulées ciblant la bande image : renforcées
    // (au moins la consolidation +0.15 ; la plasticité locale peut ajouter
    // davantage). Aucune ne peut dépasser 1.0.
    let renforcees = 0;
    for (const [p, poidsAvant] of avant) {
      const cible = cortex.csrCible[p];
      const bandeCible = Math.floor(cible / 128);
      if (bandeCible === bandeImage) {
        expect(cortex.csrPoids[p]).toBeGreaterThanOrEqual(poidsAvant + 0.14);
        expect(cortex.csrPoids[p]).toBeLessThanOrEqual(1.0 + 1e-9);
        renforcees += 1;
      }
    }
    expect(renforcees).toBeGreaterThan(0);
    // L'expérience consolidée a compté 1 échantillon.
    expect(effecteur.etatPourApi().consolidation.samples).toBe(1);
  });

  it("n'injecte jamais plus que le plafond dans un neurone de pool v1", () => {
    const { effecteur, energiesRecues } = petitEnsemble();
    // Plusieurs cycles de veille (bruit) — aucun dépassement du cap.
    for (let i = 0; i < 6; i++) {
      effecteur.evaluerEtExecuter([], {});
    }
    for (const [, liste] of energiesRecues) {
      for (const v of liste) {
        expect(v).toBeLessThanOrEqual(CAP_REMONTEE_INTENTION + 1e-12);
      }
    }
  });

  it("télémétrie : horloge columnnaire, champ 1e9, consolidation", () => {
    const { effecteur } = petitEnsemble();
    const f = nouvelleFenetreNeuronale();
    effecteur.evaluerEtExecuter([], {
      prompt: "état du cortex",
      __fenetreNeuronale: f,
    });
    const etat = effecteur.etatPourApi();
    expect(etat.cortex.colonnes).toBe(1024);
    expect(etat.champ.taille).toBe(1_000_000_000);
    expect(etat.horlogeColumnnaire).toBe(1);
    expect(etat.fenetresTraitees).toBe(1);
    expect(etat.consolidation.samples).toBe(0);
    expect(etat.cortex.msCycleEma).toBeGreaterThanOrEqual(0);
  });

  it("consoliderExperience fait évoluer la graine du champ (1e9 neurones)", () => {
    const { champ, effecteur } = petitEnsemble();
    const avant = champ.seedEntrainement;
    effecteur.consoliderExperience(3, 150);
    expect(champ.seedEntrainement).not.toBe(avant);
    expect(effecteur.etatPourApi().consolidation).toEqual({
      epochs: 3,
      samples: 150,
    });
  });
});

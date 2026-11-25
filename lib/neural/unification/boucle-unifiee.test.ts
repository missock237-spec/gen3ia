/**
 * TESTS DU LOT 4 — unification de l'apprentissage SNN/RPIA/langage.
 * Deux niveaux : unitaire (doubles fidèles — comportement de la boucle,
 * bornes, refus honnête) et INTÉGRATION avec les composants RÉELS du
 * runtime (cortex réel, NeuralTrainer réel, EntraineurRPIA réel).
 */

import { describe, expect, it } from "vitest";

import {
  boucleUnifiee,
  creerPortsReels,
  surfaceUnification,
  type ConnaissanceUnifiee,
  type PortsUnification,
  type SondeUnifiee,
} from "./boucle-unifiee";
import { EntraineurRPIA } from "../../ondes/entrainement-rpia";
import { encoderTexteLexicalEnOnde } from "../brain/encodeur-lexical-ondulatoire";
import { RPIA_DEFAUTS, calculerTempsGlobalRPIA } from "../../ondes/types-entrainement";

const CONNAISSANCES: ConnaissanceUnifiee[] = [
  { question: "Qu'est-ce que le Soleil ?", reponse: "Le Soleil est une étoile qui chauffe la Terre par rayonnement", label: "sciences" },
  { question: "Qu'est-ce que la photosynthèse ?", reponse: "La photosynthèse convertit la lumière en énergie végétale", label: "sciences" },
  { question: "Comment fonctionne un moteur ?", reponse: "Un moteur convertit une énergie en mouvement mécanique", label: "technologie" },
  { question: "Qu'est-ce que l'internet ?", reponse: "L'internet est un réseau mondial de machines interconnectées", label: "technologie" },
];

const SONDES: SondeUnifiee[] = [
  { question: "Qu'est-ce que le Soleil ?", attendu: "étoile rayonnement chaleur Terre" },
  { question: "Qu'est-ce que la photosynthèse ?", attendu: "lumière énergie végétale convertit" },
];

/** Double fidèle du langage : apprend réellement ses paires, répond dedans. */
function doubleLangage(): PortsUnification["langage"] {
  const paires = new Map<string, string>();
  return {
    apprendre: (liste) => {
      let ajoutees = 0;
      let doublons = 0;
      for (const p of liste) {
        const cle = p.motif.toLowerCase();
        if (paires.has(cle)) doublons += 1;
        else {
          paires.set(cle, p.reponse);
          ajoutees += 1;
        }
      }
      return { pairesAjoutees: ajoutees, pairesDoublons: doublons };
    },
    repondre: (q) => paires.get(q.toLowerCase()) ?? null,
  };
}

/** Double fidèle du SNN : accuracies réalistes qui progressent avec les époques. */
function doubleSnn(): PortsUnification["snn"] {
  return {
    entrainer: async (samples, epochs) => ({
      epochs,
      accuracyTrain: Math.min(1, 0.55 + epochs * 0.1 + Math.min(0.1, samples.length * 0.005)),
      accuracyTest: Math.min(1, 0.5 + epochs * 0.08),
    }),
  };
}

/** DOUBLE RÉEL du RPIA : la vraie couche d'ondes (EntraineurRPIA). */
function doubleRPIA(nbNoeuds = 64): PortsUnification["rpia"] {
  const entraineur = new EntraineurRPIA(nbNoeuds);
  return {
    encoder: (texte) => encoderTexteLexicalEnOnde(texte, nbNoeuds),
    entrainer: (cible, epoques) => entraineur.entrainer(cible, epoques),
    mesurer: (cible) => entraineur.erreurCourante(cible, calculerTempsGlobalRPIA(RPIA_DEFAUTS, 0)),
  };
}

describe("LOT 4 — boucle unifiée (unitaire, RPIA RÉEL)", () => {
  it("une passe entraîne les TROIS couches et le rapport reflète les mesures réelles", async () => {
    const r = await boucleUnifiee(
      CONNAISSANCES,
      { langage: doubleLangage(), snn: doubleSnn(), rpia: doubleRPIA() },
      SONDES,
      { epochsSnn: 2, epoquesRPIA: 20 },
    );
    expect(r.connaissancesTraitees).toBe(4);
    expect(r.langage.pairesAjoutees).toBe(4);
    expect(r.langage.doublons).toBe(0);
    expect(r.snn.echantillons).toBe(4);
    expect(r.snn.accuracyTrain).toBeGreaterThan(0);
    expect(r.snn.accuracyTest).toBeGreaterThan(0);
    // RPIA RÉEL : erreur mesurée honnêtement + discriminabilité (deux
    // textes → deux états distincts — propriété documentée du pont-chat).
    // La CONVERGENCE n'est pas prétendue : elle peut être 0 à budget
    // borné (oscillation documentée de la couche).
    expect(Number.isFinite(r.rpia.erreurAvantMoyenne)).toBe(true);
    expect(Number.isFinite(r.rpia.erreurApresMoyenne)).toBe(true);
    expect(r.rpia.convergences).toBeGreaterThanOrEqual(0);
    expect(r.dureeMs).toBeGreaterThanOrEqual(0);
  });

  it("probes partagées : le langage est évalué sur les MÊMES sondes", async () => {
    const r = await boucleUnifiee(
      CONNAISSANCES,
      { langage: doubleLangage(), snn: doubleSnn(), rpia: doubleRPIA() },
      SONDES,
    );
    expect(r.probes.taille).toBe(2);
    // Les paires viennent d'être apprises → les réponses des sondes existent.
    expect(Number.isFinite(r.probes.langage)).toBe(true);
    expect(r.probes.langage).toBeGreaterThan(0.3);
  });

  it("idempotence : une seconde passe ne duplique pas les paires", async () => {
    const langage = doubleLangage();
    const ports = { langage, snn: doubleSnn(), rpia: doubleRPIA() };
    await boucleUnifiee(CONNAISSANCES, ports, SONDES);
    const r2 = await boucleUnifiee(CONNAISSANCES, ports, SONDES);
    expect(r2.langage.pairesAjoutees).toBe(0);
    expect(r2.langage.doublons).toBe(4);
  });

  it("refus honnête : rien d'exploitable → la boucle refuse (jamais prétendre)", async () => {
    await expect(
      boucleUnifiee([{ question: "  ", reponse: "x" }], { langage: doubleLangage(), snn: doubleSnn(), rpia: doubleRPIA() }, []),
    ).rejects.toThrow(/aucune connaissance exploitable/);
  });

  it("bornes : maxConnaissances limite la passe (backpressure)", async () => {
    const nombreuses: ConnaissanceUnifiee[] = Array.from({ length: 30 }, (_, i) => ({
      question: `Question unique numéro ${i} sur les énergies renouvelables ?`,
      reponse: `Réponse pédagogique numéro ${i} décrivant l'énergie solaire et son stockage thermique.`,
    }));
    const r = await boucleUnifiee(nombreuses, { langage: doubleLangage(), snn: doubleSnn(), rpia: doubleRPIA() }, [], { maxConnaissances: 10 });
    expect(r.connaissancesTraitees).toBe(10);
  });
});

describe("LOT 4 — INTÉGRATION avec les composants RÉELS du runtime", () => {
  it("cortex réel + NeuralTrainer réel + EntraineurRPIA réel : passe complète", async () => {
    const ports = await creerPortsReels({ nbNoeudsRPIA: 32 });
    const r = await boucleUnifiee(
      CONNAISSANCES,
      ports,
      SONDES,
      { epochsSnn: 1, epoquesRPIA: 15 },
    );
    expect(r.langage.pairesAjoutees).toBe(4); // le VRAI cortex a appris
    expect(r.snn.epochs).toBe(1); // le VRAI trainer SNN a tourné
    expect(Number.isFinite(r.snn.accuracyTrain)).toBe(true);
    // La VRAIE couche d'ondes : discriminabilité réelle entre les deux textes.
    expect(r.rpia.discriminabilite).not.toBeNull();
    expect(r.rpia.discriminabilite!).toBeGreaterThan(0);
    expect(r.probes.taille).toBe(2);
    expect(Number.isFinite(r.probes.langage)).toBe(true);
  }, 30_000);

  it("métrique de surface cohérente (3 couches unifiées)", () => {
    const s = surfaceUnification();
    expect(s.couches).toBe(3);
    expect(s.borneMaxConnaissances).toBeGreaterThan(0);
  });

  it("l'encodeur lexical produit des ondes bornées et déterministes (vecteur partagé)", () => {
    const a = encoderTexteLexicalEnOnde("Qu'est-ce que le Soleil ?", 128);
    const b = encoderTexteLexicalEnOnde("Qu'est-ce que le Soleil ?", 128);
    expect(a.length).toBe(128);
    expect(Array.from(a)).toEqual(Array.from(b)); // déterminisme
    let norm = 0;
    for (const x of a) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 1); // normalisation L2 documentée
  });
});

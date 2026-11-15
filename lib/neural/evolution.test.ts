import { describe, expect, it } from "vitest";

import { MoteurEvolutionGen3, type CortexConsolidable } from "./evolution";
import { CortexLangagierGen3 } from "./generation/language";
import type { StatsApprentissageLangage } from "./generation/language";

/* ------------------------------------------------------------------ */
/* Moteur d'évolution continue — consolidation honnête : seuls les      */
/* rappels cortex fiables deviennent des connaissances durables, les    */
/* doublons sont dédupliqués, les métriques sont réelles.               */
/* ------------------------------------------------------------------ */

function cortexFactice(initial: Array<{ motif: string; reponse: string }> = []) {
  const connues = new Set(initial.map((p) => p.motif.split(/\s+/).sort().join(" ")));
  let personnalisees = initial.length;
  const cortex: CortexConsolidable = {
    apprendre(paires, opts): StatsApprentissageLangage {
      let ajoutees = 0;
      let doublons = 0;
      for (const paire of paires) {
        const cle = paire.motif.split(/\s+/).sort().join(" ");
        if (connues.has(cle)) {
          doublons += 1;
          continue;
        }
        if (opts.personnalisees) personnalisees += 1;
        connues.add(cle);
        ajoutees += 1;
      }
      return { pairesAjoutees: ajoutees, pairesDoublons: doublons, vocabulaire: connues.size, totalPaires: connues.size };
    },
    compterPersonnalisees: () => personnalisees,
  };
  return cortex;
}

describe("MoteurEvolutionGen3 — observation", () => {
  it("écarte les réponses venues du décodeur (pas des connaissances stables)", () => {
    const moteur = new MoteurEvolutionGen3(cortexFactice());
    moteur.observer({ question: "état du réseau ?", reponse: "312 neurones actifs, 42 synapses", score: 0.9, source: "decoder_intention" });
    const m = moteur.metriques();
    expect(m.echangesObserves).toBe(1);
    expect(m.echangesEcarts).toBe(1);
    expect(m.echangesConsolides).toBe(0);
    expect(moteur.pretPourConsolidation()).toBe(false);
  });

  it("écarte les scores trop bas (rappel non fiable)", () => {
    const moteur = new MoteurEvolutionGen3(cortexFactice(), { seuilScore: 0.5 });
    moteur.observer({ question: "question floue", reponse: "réponse", score: 0.35, source: "cortex_corpus" });
    expect(moteur.metriques().echangesEcarts).toBe(1);
  });

  it("écarte les échanges vides", () => {
    const moteur = new MoteurEvolutionGen3(cortexFactice());
    moteur.observer({ question: "  ", reponse: "réponse", score: 0.9, source: "cortex_corpus" });
    moteur.observer({ question: "question", reponse: "", score: 0.9, source: "cortex_corpus" });
    expect(moteur.metriques().echangesEcarts).toBe(2);
  });

  it("accepte les rappels cortex fiables et borne la file", () => {
    const moteur = new MoteurEvolutionGen3(cortexFactice(), { tailleFileMax: 3, periodicite: 100 });
    for (let i = 0; i < 6; i += 1) {
      moteur.observer({ question: `question unique ${i}`, reponse: `réponse ${i}`, score: 0.8, source: "cortex_corpus" });
    }
    const m = moteur.metriques();
    expect(m.echangesObserves).toBe(6);
    expect(m.echangesEcarts).toBe(0);
    // La file est bornée à 3 : consolider n'enseigne jamais plus que 3.
    const resultat = moteur.consolider();
    expect(resultat.enseignees).toBeLessThanOrEqual(3);
  });
});

describe("MoteurEvolutionGen3 — consolidation", () => {
  it("transforme les échanges de qualité en paires personnalisées", () => {
    const cortex = cortexFactice();
    const moteur = new MoteurEvolutionGen3(cortex, { periodicite: 2 });
    moteur.observer({ question: "quelle est la politique de retour ?", reponse: "14 jours, article non ouvert.", score: 0.9, source: "cortex_personnalisee" });
    expect(moteur.consoliderSiPret()).toBeNull();
    moteur.observer({ question: "livrez-vous en Guadeloupe ?", reponse: "Oui, en 5 à 7 jours ouvrés.", score: 0.7, source: "cortex_contexte" });
    const resultat = moteur.consoliderSiPret();
    expect(resultat).not.toBeNull();
    expect(resultat!.enseignees).toBe(2);
    expect(resultat!.dejaConnues).toBe(0);
    expect(cortex.compterPersonnalisees()).toBe(2);
    expect(moteur.metriques().cyclesConsolidation).toBe(1);
    expect(moteur.metriques().derniereConsolidation).not.toBeNull();
  });

  it("déduplique les motifs déjà connus (consolidation idempotente)", () => {
    const cortex = cortexFactice([{ motif: "quelle est la politique de retour", reponse: "14 jours" }]);
    const moteur = new MoteurEvolutionGen3(cortex, { periodicite: 1 });
    moteur.observer({ question: "quelle est la politique de retour", reponse: "14 jours", score: 0.8, source: "cortex_corpus" });
    const resultat = moteur.consoliderSiPret();
    expect(resultat!.enseignees).toBe(0);
    expect(resultat!.dejaConnues).toBe(1);
    expect(cortex.compterPersonnalisees()).toBe(1);
  });

  it("plafonne le volume par cycle (pas de rafale d'apprentissage)", () => {
    const cortex = cortexFactice();
    const moteur = new MoteurEvolutionGen3(cortex, { periodicite: 20, maxParCycle: 5 });
    for (let i = 0; i < 12; i += 1) {
      moteur.observer({ question: `question ${i} différente`, reponse: `réponse ${i}`, score: 0.8, source: "cortex_corpus" });
    }
    const resultat = moteur.consolider();
    expect(resultat.enseignees).toBe(5);
    // Il reste des échanges en file pour le prochain cycle.
    expect(moteur.consolider().enseignees).toBeGreaterThan(0);
  });

  it("fonctionne sans cortex (dégradation propre)", () => {
    const moteur = new MoteurEvolutionGen3(null);
    moteur.observer({ question: "q", reponse: "r", score: 0.9, source: "cortex_corpus" });
    const resultat = moteur.consolider();
    expect(resultat.enseignees).toBe(0);
    expect(resultat.stats).toBeNull();
  });
});

describe("MoteurEvolutionGen3 — intégration avec le vrai cortex", () => {
  it("les paires consolidées sont réellement rappelables ensuite", () => {
    const cortex = new CortexLangagierGen3();
    const moteur = new MoteurEvolutionGen3(cortex, { periodicite: 1, seuilScore: 0.4 });
    moteur.observer({
      question: "quel est le code promo pour le lancement",
      reponse: "Le code GEN3LANCE offre 20 % pendant le lancement.",
      score: 0.9,
      source: "cortex_personnalisee",
    });
    const resultat = moteur.consoliderSiPret();
    expect(resultat!.enseignees).toBe(1);
    // La consolidation ENSEIGNE le cortex (mesure de rétention possible)…
    const mesure = cortex.repondre("quel est le code promo du lancement ?", {}, { inclureMesure: true });
    expect(mesure?.texte).toBe("Le code GEN3LANCE offre 20 % pendant le lancement.");
    // …mais ne répond PLUS au chat : la consolidation automatique d'échanges
    // est globale au serveur — seuls l'enseignement explicite et les
    // abréviations restent conversationnels (rectification hors-sujets).
    expect(cortex.repondre("quel est le code promo du lancement ?")).toBeNull();
  });
});

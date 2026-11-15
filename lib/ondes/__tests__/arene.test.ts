import { describe, expect, it } from "vitest";

import { AreneInterference, EntrainementParResonance, DIM_ARENE } from "@/lib/ondes/arene";
import { texteVersVecteur } from "@/lib/ondes/codec";
import { CortexLangagierGen3 } from "@/lib/neural/generation/language";
import type { PaireLangage } from "@/lib/neural/generation/corpus";

const PAIRES: PaireLangage[] = [
  { motif: "quelle est la capitale de la france", reponse: "La capitale de la France est Paris.", theme: "geographie" },
  { motif: "qu'est-ce qu'une onde", reponse: "Une onde est une propagation d'une perturbation.", theme: "physique" },
  { motif: "comment fonctionne la photosynthese", reponse: "La photosynthèse convertit la lumière en énergie chimique.", theme: "biologie" },
  { motif: "qui a écrit les miserables", reponse: "Les Misérables ont été écrits par Victor Hugo.", theme: "litterature" },
  { motif: "qu'est-ce que la gravité", reponse: "La gravité est l'attraction entre les masses.", theme: "physique" },
  { motif: "quelle heure est-il a douala", reponse: "Douala est à l'heure d'Afrique de l'Ouest (WAT).", theme: "geographie" },
];

function cortexAvecPaires(): CortexLangagierGen3 {
  const cortex = new CortexLangagierGen3();
  cortex.apprendre(PAIRES);
  return cortex;
}

describe("arène d'interférence — la physique juge les idées", () => {
  it("deux réponses identiques entrent en résonance constructive (corrélation positive)", () => {
    const arene = new AreneInterference();
    const mesures = arene.duelTextes("La capitale de la France est Paris.", "La capitale de la France est Paris.");
    expect(mesures.correlation).toBeGreaterThan(0.85);
    expect(mesures.resonance).toBeGreaterThan(0.5);
    expect(mesures.reward).toBeGreaterThan(0.4);
  });

  it("deux réponses opposées s'annihilent (interférence destructive)", () => {
    const arene = new AreneInterference();
    const texte = "La capitale de la France est Paris.";
    const opposé = "La capitale de la France n'est pas Paris.";
    const mesures = arene.duelTextes(texte, opposé);
    expect(mesures.correlation).toBeLessThan(mesuresCorrIdentique());
  });

  it("l'annihilation pure : un vecteur contre son exact opposé s'éteint physiquement", () => {
    const arene = new AreneInterference();
    const a = texteVersVecteur("La capitale de la France est Paris.", 256);
    const b = texteVersVecteur("La capitale de la France est Paris.", 256);
    for (let i = 0; i < b.length; i++) b[i] = -b[i]; // anti-onde exacte
    const mesures = arene.duelVecteurs(a, b);
    expect(mesures.correlation).toBeLessThan(-0.9);
    expect(mesures.annihilation).toBeGreaterThan(0.5);
    expect(mesures.reward).toBeLessThan(-0.5);
  });

  it("les vecteurs orthogonaux restent neutres (aucune interférence nette)", () => {
    const arene = new AreneInterference();
    const a = new Float64Array(256);
    const b = new Float64Array(256);
    for (let i = 0; i < 64; i++) a[i] = 1;
    for (let i = 128; i < 192; i++) b[i] = 1;
    const mesures = arene.duelVecteurs(a, b);
    expect(Math.abs(mesures.correlation)).toBeLessThan(0.35);
    expect(mesures.reward).toBeLessThan(0.5);
  });

  it("un champ vide contre un champ rempli ne résonne pas (énergie nulle)", () => {
    const arene = new AreneInterference();
    const v = texteVersVecteur("une réponse bien réelle", 256);
    const zero = new Float64Array(256);
    const mesures = arene.duelVecteurs(v, zero);
    expect(mesures.energieB).toBe(0);
    expect(mesures.correlation).toBe(0);
  });

  it("la grille de l'arène fait la taille annoncée et reste reproductible", () => {
    const arene = new AreneInterference();
    expect(arene.configuration.largeur).toBe(DIM_ARENE);
    const m1 = arene.duelTextes("onde A", "onde B");
    const m2 = arene.duelTextes("onde A", "onde B");
    expect(m1.correlation).toBeCloseTo(m2.correlation, 10);
  });
});

/** Corrélation d'un texte contre lui-même (référence du test précédent). */
function mesuresCorrIdentique(): number {
  const arene = new AreneInterference();
  const texte = "La capitale de la France est Paris.";
  return arene.duelTextes(texte, texte).correlation;
}

describe("entraînement par résonance — physics-guided reinforcement", () => {
  it("un élève vierge est distillé par le professeur (il apprend par les ondes)", () => {
    const prof = cortexAvecPaires();
    const eleve = new CortexLangagierGen3(); // vierge : il ne sait rien
    const entrainement = new EntrainementParResonance(prof, eleve);
    const rapport = entrainement.entrainer(PAIRES.map((p) => p.motif));

    expect(rapport.distillees).toBeGreaterThan(0);
    expect(rapport.etatEleve.pairesPersonnalisees.length).toBeGreaterThan(0);
    // L'élève a appris au moins une des réponses du professeur.
    const reponseApprise = eleve.repondre("quelle est la capitale de la france");
    expect(reponseApprise).not.toBeNull();
    expect(reponseApprise!.texte).toContain("Paris");
  });

  it("un élève qui sait déjà répond en résonance et est renforcé (pas de distillation)", () => {
    const prof = cortexAvecPaires();
    const eleve = cortexAvecPaires(); // sait les mêmes choses
    const entrainement = new EntrainementParResonance(prof, eleve);
    const rapport = entrainement.entrainer(PAIRES.map((p) => p.motif));

    expect(rapport.renforcees).toBeGreaterThan(0);
    expect(rapport.rewardMoyen).toBeGreaterThan(0);
  });

  it("le champ élève garde une mémoire fréquentielle après l'entraînement (ressenti persistant)", () => {
    const prof = cortexAvecPaires();
    const eleve = new CortexLangagierGen3();
    const entrainement = new EntrainementParResonance(prof, eleve);
    const avant = entrainement.memoireFrequentielle.slice();
    entrainement.entrainer(PAIRES.map((p) => p.motif));
    const apres = entrainement.memoireFrequentielle;
    let differences = 0;
    for (let i = 0; i < apres.length; i++) {
      if (apres[i] !== avant[i]) differences++;
    }
    expect(differences).toBeGreaterThan(0);
  });

  it("les rounds où le professeur ne sait rien sont tous ignorés (honnêteté de l'arène)", () => {
    const prof = new CortexLangagierGen3(); // vierge : il ne répond jamais
    const eleve = new CortexLangagierGen3();
    eleve.apprendre(PAIRES);
    const entrainement = new EntrainementParResonance(prof, eleve);
    const rapport = entrainement.entrainer(PAIRES.map((p) => p.motif));
    expect(rapport.ignorees).toBe(PAIRES.length);
    expect(rapport.rounds.every((r) => r.action === "ignoree" && r.reponseProfesseur === "")).toBe(true);
    expect(rapport.etatEleve.pairesPersonnalisees.length).toBe(0); // rien n'a été enseigné
  });
});

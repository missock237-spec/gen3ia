/**
 * TESTS it.94 — générateur de raisonnement 7 familles + corpus branché.
 * Garanties vérifiées : déterminisme, unicité des motifs, réponses calculées
 * (non vides, structurées), thème cohérent, éval réservée DISJOINTE du train.
 */
import { describe, expect, it } from "vitest";

import {
  FAMILLES_IT94,
  genererRaisonnementIt94,
} from "./raisonnement-it94";
import {
  CORPUS_RAISONNEMENT_IT94,
  CORPUS_RAISONNEMENT_IT94_EVAL,
} from "../neural/generation/corpus-raisonnement-it94";
import { CORPUS_GEN3 } from "../neural/generation/corpus";

describe("générateur raisonnement it.94", () => {
  it("couvre exactement les 7 familles à zéro mesuré", () => {
    expect(FAMILLES_IT94).toHaveLength(7);
    expect(new Set(FAMILLES_IT94).size).toBe(7);
  });

  it("est déterministe (même graine → mêmes motifs)", () => {
    const a = genererRaisonnementIt94(70, 42).map((p) => p.motif);
    const b = genererRaisonnementIt94(70, 42).map((p) => p.motif);
    expect(a).toEqual(b);
    const c = genererRaisonnementIt94(70, 99).map((p) => p.motif);
    expect(a).not.toEqual(c);
  });

  it("produit des motifs uniques et des réponses calculées structurées", () => {
    const paires = genererRaisonnementIt94(210, 42);
    const motifs = new Set(paires.map((p) => p.motif));
    expect(paires).toHaveLength(motifs.size);
    for (const p of paires) {
      expect(p.motif.length).toBeGreaterThan(20);
      expect(p.reponse.length).toBeGreaterThan(60);
      expect(p.reponse).toMatch(/Donc :/);
      expect(p.theme).toBe(`raisonnement-${p.famille}`);
    }
  });

  it("s'épuise honnêtement quand l'espace de motifs est fini (analogie)", () => {
    const paires = genererRaisonnementIt94(300, 42);
    const analogies = paires.filter((p) => p.famille === "analogie");
    // la banque analogique déclarée compte 18 paires distinctes — le
    // générateur ne doit JAMAIS en inventer davantage (honnêteté)
    expect(analogies.length).toBeLessThanOrEqual(18);
    const conditionnels = paires.filter((p) => p.famille === "conditionnel");
    // 10 règles × 3 variantes = 30 motifs distincts maximum
    expect(conditionnels.length).toBeLessThanOrEqual(30);
  });

  it("le mode éval produit des formulations inédites jamais vues en mode chat", () => {
    const chat = genererRaisonnementIt94(300, 42).map((p) => p.motif);
    const setChat = new Set(chat);
    const evalP = genererRaisonnementIt94(10, 20261105, true);
    expect(evalP).toHaveLength(70);
    for (const p of evalP) {
      expect(setChat.has(p.motif)).toBe(false);
      expect(p.motif).toMatch(/^(Exercice d'évaluation|Raisonnons pas à pas|Question de contrôle|Test de compréhension)/);
    }
  });

  it("les réponses de déduction concluent selon les prémisses (calcul)", () => {
    const paires = genererRaisonnementIt94(300, 42);
    const directes = paires.filter(
      (p) => p.famille === "deduction" && p.motif.startsWith("Tous les") && p.motif.includes("Que peut-on en déduire"),
    );
    expect(directes.length).toBeGreaterThan(0);
    for (const p of directes) {
      // « Tous les X sont des Y » ⇒ la réponse répète les deux termes de la règle
      const m = p.motif.match(/Tous les (\S+) sont des ([^.]+)\./);
      expect(m).not.toBeNull();
      if (m) {
        expect(p.reponse).toContain(m[1]);
        expect(p.reponse).toContain(m[2]);
      }
    }
  });

  it("les sommes temporelles sont exactes (d1 + d2 présentes dans la réponse)", () => {
    const paires = genererRaisonnementIt94(300, 42);
    const sommes = paires.filter(
      (p) => p.famille === "temporel" && p.reponse.includes("En substituant"),
    );
    expect(sommes.length).toBeGreaterThan(0);
    for (const p of sommes) {
      const jours = [...p.motif.matchAll(/a lieu (\d+) jours après/g)].map((m) => Number(m[1]));
      const total = p.reponse.match(/a lieu (\d+) jours après/);
      if (jours.length >= 2 && total) {
        expect(Number(total[1])).toBe(jours[0] + jours[1]);
      }
    }
  });
});

describe("corpus raisonnement it.94 branché", () => {
  it("134 paires chat (banques finies honnêtes) + 70 paires éval réservée", () => {
    // 7 familles × 20 demandées, mais analogie s'épuise à 18 et causalité à 16
    // (banques déclarées finies — le générateur n'invente rien) : 134 réelles.
    expect(CORPUS_RAISONNEMENT_IT94).toHaveLength(134);
    expect(CORPUS_RAISONNEMENT_IT94_EVAL).toHaveLength(70);
    expect(CORPUS_RAISONNEMENT_IT94.filter((p) => p.theme === "raisonnement-analogie")).toHaveLength(18);
    expect(CORPUS_RAISONNEMENT_IT94.filter((p) => p.theme === "raisonnement-causalite")).toHaveLength(16);
  });

  it("les 7 familles sont représentées dans le corpus chat", () => {
    const themes = new Set(CORPUS_RAISONNEMENT_IT94.map((p) => p.theme));
    for (const f of FAMILLES_IT94) {
      expect(themes.has(`raisonnement-${f}`)).toBe(true);
    }
  });

  it("aucune fuite : l'éval réservée n'apparaît jamais dans le train", () => {
    const motifsTrain = new Set(CORPUS_RAISONNEMENT_IT94.map((p) => p.motif));
    for (const p of CORPUS_RAISONNEMENT_IT94_EVAL) {
      expect(motifsTrain.has(p.motif)).toBe(false);
    }
  });

  it("le corpus de production inclut les paires it.94", () => {
    const motifs = new Set(CORPUS_GEN3.map((p) => p.motif));
    let presentes = 0;
    for (const p of CORPUS_RAISONNEMENT_IT94) {
      if (motifs.has(p.motif)) presentes += 1;
    }
    expect(presentes).toBe(CORPUS_RAISONNEMENT_IT94.length);
  });
});

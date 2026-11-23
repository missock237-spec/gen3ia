import { describe, expect, it } from "vitest";

import { MAX_PAIRES_DATASET, parserDatasetGen3 } from "@/lib/training/engines/gen3-dataset";
import {
  construireDataset,
  genererCiblesOnde,
  genererExemplesClassification,
  genererPairesLangage,
  nombreEnLettres,
  separerDonnees,
} from "./synthetique";

/**
 * DONNÉES SYNTHÉTIQUES — paires Q/R, exemples classés et cibles d'onde,
 * déterministes (même graine → mêmes données), réponses CALCULÉES par code,
 * export jsonl/csv réellement parseable par le studio d'entraînement.
 */
describe("synthetique — générateur déterministe adapté au modèle cible", () => {
  it("déterminisme : même graine → mêmes données ; graine différente → différentes", () => {
    const a = genererPairesLangage({ nombre: 50, graine: 42 });
    const b = genererPairesLangage({ nombre: 50, graine: 42 });
    const c = genererPairesLangage({ nombre: 50, graine: 43 });
    expect(a.paires).toEqual(b.paires);
    expect(a.paires).not.toEqual(c.paires);

    const ondeA = genererCiblesOnde({ nombre: 5, graine: 7 });
    const ondeB = genererCiblesOnde({ nombre: 5, graine: 7 });
    expect(Array.from(ondeA.cibles[0])).toEqual(Array.from(ondeB.cibles[0]));
  });

  it("paires langage : questions distinctives (nombres en LETTRES + référence unique)", () => {
    // Les chiffres sont filtrés par le rappel du cortex — les opérandes en
    // lettres rendent chaque question RÉTROUVABLE exactement (conception).
    expect(nombreEnLettres(12)).toBe("douze");
    expect(nombreEnLettres(42)).toBe("quarante-deux");
    expect(nombreEnLettres(71)).toBe("soixante-et-onze");
    expect(nombreEnLettres(80)).toBe("quatre-vingts");
    expect(nombreEnLettres(91)).toBe("quatre-vingt-onze");
    expect(nombreEnLettres(99)).toBe("quatre-vingt-dix-neuf");
    const { paires } = genererPairesLangage({ nombre: 120, graine: 2026 });
    const arithmetiques = paires.filter((p) => p.question.includes("Combien font"));
    expect(arithmetiques.length).toBeGreaterThan(10);
    for (const paire of arithmetiques.slice(0, 20)) {
      expect(paire.reponse).toMatch(/ = -?\d+/);
      expect(paire.question).toMatch(/réf\. [a-z][a-z]\d{2}/); // référence unique (2 lettres + 2 chiffres)
    }
  });

  it("déduplication : aucun motif en double, doublonsIgnores compte les collisions", () => {
    const { paires, doublonsIgnores } = genererPairesLangage({ nombre: 300, graine: 11 });
    const uniques = new Set(paires.map((p) => p.question.toLowerCase()));
    expect(uniques.size).toBe(paires.length);
    expect(typeof doublonsIgnores).toBe("number");
  });

  it("plafond : la demande au-delà de la cap est bornée honnêtement", () => {
    const { paires } = genererPairesLangage({ nombre: 999_999, graine: 5 });
    expect(paires.length).toBeLessThanOrEqual(MAX_PAIRES_DATASET);
  });

  it("classification : clusters séparables, labels cohérents, dimensions fixes", () => {
    const { exemples, labels } = genererExemplesClassification({ nombre: 150, classes: 3, dimensions: 4, graine: 9 });
    expect(exemples).toHaveLength(150);
    expect(labels).toEqual(["classe-1", "classe-2", "classe-3"]);
    for (const exemple of exemples) {
      expect(exemple.entrees).toHaveLength(4);
      expect(labels).toContain(exemple.label);
    }
  });

  it("onde : cibles normalisées dans [-1, 1], longueur exacte de nœuds", () => {
    const { cibles } = genererCiblesOnde({ nombre: 6, noeuds: 64, harmoniques: 3, graine: 3 });
    expect(cibles).toHaveLength(6);
    for (const cible of cibles) {
      expect(cible).toHaveLength(64);
      for (const v of cible) expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
  });

  it("dataset langage jsonl : réellement parseable par parserDatasetGen3 (studio)", () => {
    const dataset = construireDataset({ famille: "langage", nombre: 60, graine: 777 });
    const parse = parserDatasetGen3("jsonl", dataset.contenu);
    expect(parse.paires).toHaveLength(dataset.elements);
    expect(parse.paires[0].question.length).toBeGreaterThan(0);
    expect(dataset.format).toBe("jsonl");
  });

  it("dataset csv : en-tête question,reponse + échappement des guillemets", () => {
    const dataset = construireDataset({ famille: "langage", nombre: 20, graine: 8, format: "csv" });
    const lignes = dataset.contenu.split("\n");
    expect(lignes[0]).toBe("question,reponse");
    expect(lignes.length).toBe(21);
    expect(dataset.apercu.length).toBeGreaterThan(0);
  });

  it("dataset classification et onde : export jsonl exploitable", () => {
    const cls = construireDataset({ famille: "classification", nombre: 40, graine: 2 });
    const echantillon = JSON.parse(cls.contenu.split("\n")[0]) as { entrees: number[]; label: string };
    expect(echantillon.entrees.length).toBeGreaterThan(1);
    expect(typeof echantillon.label).toBe("string");
    const onde = construireDataset({ famille: "onde", nombre: 10, noeudsOnde: 32, graine: 2 });
    const cible = JSON.parse(onde.contenu.split("\n")[0]) as { onde: number[] };
    expect(cible.onde).toHaveLength(32);
  });

  it("split train/test : déterministe, disjoint, ratio respecté", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const s1 = separerDonnees(items, 0.25, 99);
    const s2 = separerDonnees(items, 0.25, 99);
    expect(s1).toEqual(s2);
    expect(s1.train.length + s1.test.length).toBe(100);
    expect(s1.test.length).toBe(25);
    const idsTest = new Set(s1.test);
    expect(s1.train.some((i) => idsTest.has(i))).toBe(false);
  });
});

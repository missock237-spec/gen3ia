import { describe, expect, it } from "vitest";

import { parserDatasetGen3, separerTrainTest, MAX_PAIRES_DATASET } from "./gen3-dataset";

/* ------------------------------------------------------------------ */
/* Parsing des datasets du moteur Gen3 natif — compteurs honnêtes,      */
/* plafonds appliqués, aucun élément avalé silencieusement.             */
/* ------------------------------------------------------------------ */

describe("parserDatasetGen3", () => {
  it("parse un JSON : tableau d'objets instruction/response", () => {
    const contenu = JSON.stringify([
      { instruction: "Quelle est la capitale du Sénégal ?", response: "Dakar." },
      { instruction: "Qui a écrit Kabale und Liebe ?", response: "Schiller." },
    ]);
    const resultat = parserDatasetGen3("json", contenu);
    expect(resultat.paires).toHaveLength(2);
    expect(resultat.paires[0]).toEqual({ question: "Quelle est la capitale du Sénégal ?", reponse: "Dakar." });
    expect(resultat.ignores).toBe(0);
  });

  it("parse un JSONL ligne à ligne et signale les lignes illisibles", () => {
    const contenu = [
      '{"question":"Bonjour ?","answer":"Bonjour !"}',
      "pas du json",
      '{"question":"","answer":"vide"}',
    ].join("\n");
    const resultat = parserDatasetGen3("jsonl", contenu);
    expect(resultat.paires).toHaveLength(1);
    expect(resultat.ignores).toBe(2);
    expect(resultat.avertissements.join(" ")).toContain("Ligne 2");
  });

  it("parse un CSV (virgule ou point-virgule) par noms de colonnes reconnus", () => {
    const resultat = parserDatasetGen3("csv", "question;reponse\nQui ?;Moi.\nOù ?;Ici.");
    expect(resultat.paires).toHaveLength(2);
    expect(resultat.paires[1].reponse).toBe("Ici.");
  });

  it("refuse un CSV sans colonne reconnue avec un avertissement explicite", () => {
    const resultat = parserDatasetGen3("csv", "col1,col2\na,b");
    expect(resultat.paires).toHaveLength(0);
    expect(resultat.avertissements.join(" ")).toContain("colonne question/réponse");
  });

  it("parse un TXT structuré en blocs Q:/A:", () => {
    const resultat = parserDatasetGen3("txt", "Q: Comment vas-tu ?\nA: Bien, merci.\n\nQuestion: Qui es-tu ?\nRéponse: Gen3ia.");
    expect(resultat.paires).toHaveLength(2);
    expect(resultat.paires[1].question).toBe("Qui es-tu ?");
  });

  it("signale un TXT sans structure Q/A plutôt que d'inventer des paires", () => {
    const resultat = parserDatasetGen3("txt", "un document libre\nsans questions");
    expect(resultat.paires).toHaveLength(0);
    expect(resultat.avertissements.join(" ")).toContain("Q:");
  });

  it("accepte les variantes de clés FR/EN (motif/réponse, prompt/output)", () => {
    const a = parserDatasetGen3("json", JSON.stringify([{ motif: "m", réponse: "r" }]));
    expect(a.paires).toEqual([{ question: "m", reponse: "r" }]);
    const b = parserDatasetGen3("json", JSON.stringify([{ prompt: "p", output: "o" }]));
    expect(b.paires).toEqual([{ question: "p", reponse: "o" }]);
  });

  it("applique le plafond de paires (MAX_PAIRES_DATASET) sans les avaler en silence", () => {
    const grosses = Array.from({ length: MAX_PAIRES_DATASET + 25 }, (_, i) => ({
      question: `q${i}`,
      response: `r${i}`,
    }));
    const resultat = parserDatasetGen3("json", JSON.stringify(grosses));
    expect(resultat.paires).toHaveLength(MAX_PAIRES_DATASET);
    expect(resultat.ignores).toBe(25);
  });

  it("ignore les enregistrements sans question OU sans réponse", () => {
    const resultat = parserDatasetGen3("json", JSON.stringify([{ response: "seule une réponse" }, { instruction: "seule une question" }]));
    expect(resultat.paires).toHaveLength(0);
    expect(resultat.ignores).toBe(2);
  });
});

describe("separerTrainTest", () => {
  const paires = Array.from({ length: 100 }, (_, i) => ({ question: `q${i}`, reponse: `r${i}` }));

  it("réserve environ ratioTest au test, jamais vu pendant l'apprentissage", () => {
    const { train, test } = separerTrainTest(paires, 0.15);
    expect(train.length + test.length).toBe(100);
    expect(test.length).toBeGreaterThan(5);
    expect(test.length).toBeLessThan(25);
    const clesTrain = new Set(train.map((p) => p.question));
    for (const t of test) expect(clesTrain.has(t.question)).toBe(false);
  });

  it("garde tout en train quand le jeu est trop petit pour un test honnête", () => {
    const petit = paires.slice(0, 3);
    const { train, test } = separerTrainTest(petit, 0.25);
    expect(train).toHaveLength(3);
    expect(test).toHaveLength(0);
  });

  it("est déterministe : deux appels donnent la même séparation", () => {
    const a = separerTrainTest(paires, 0.2);
    const b = separerTrainTest(paires, 0.2);
    expect(a.test.map((p) => p.question)).toEqual(b.test.map((p) => p.question));
  });
});

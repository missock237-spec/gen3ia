import { describe, expect, it } from "vitest";

import { renderPlanForExecution, PlanSchema, PlanCritiqueSchema } from "./planning";

describe("PlanSchema — validation stricte côté code", () => {
  it("accepte un plan bien formé", () => {
    const plan = PlanSchema.parse({
      goal: "Publier un rapport hebdomadaire",
      assumptions: ["Les données existent"],
      steps: [
        { title: "Collecter", action: "Lire le CSV", successCriteria: "10 lignes lues", risks: ["fichier absent"] },
      ],
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.assumptions).toHaveLength(1);
  });

  it("refuse un plan sans critères de succès", () => {
    expect(() =>
      PlanSchema.parse({
        goal: "x",
        steps: [{ title: "a", action: "b" }],
      }),
    ).toThrow();
  });

  it("applique les défauts (risks: [])", () => {
    const plan = PlanSchema.parse({
      goal: "x",
      steps: [{ title: "a", action: "b", successCriteria: "c" }],
    });
    expect(plan.steps[0].risks).toEqual([]);
  });
});

describe("PlanCritiqueSchema — verdicts", () => {
  it("n'accepte que les deux verdicts", () => {
    expect(() => PlanCritiqueSchema.parse({ verdict: "bof" })).toThrow();
    expect(PlanCritiqueSchema.parse({ verdict: "satisfaisant" }).issues).toEqual([]);
  });
});

describe("renderPlanForExecution — rendu injectable", () => {
  it("rend un plan complet avec validation satisfaisante", () => {
    const rendered = renderPlanForExecution({
      plan: {
        goal: "Rédiger le rapport",
        assumptions: ["Données à jour"],
        steps: [
          {
            title: "Extraire",
            action: "Lire les données",
            toolHint: "file.read",
            successCriteria: "CSV complet lu",
            risks: ["données manquantes"],
          },
        ],
      },
      critique: { verdict: "satisfaisant", issues: [], missingRisks: ["dépendance API"], vagueSteps: [] },
      revised: false,
      revisions: 0,
    });
    expect(rendered).toContain("PLAN VALIDÉ — objectif : Rédiger le rapport");
    expect(rendered).toContain("Hypothèses");
    expect(rendered).toContain("[outil : file.read]");
    expect(rendered).toContain("satisfaisante");
    expect(rendered).toContain("dépendance API");
  });

  it("affiche les défauts résiduels d'une critique non satisfaite", () => {
    const rendered = renderPlanForExecution({
      plan: { goal: "x", assumptions: [], steps: [{ title: "a", action: "b", successCriteria: "c", risks: [] }] },
      critique: { verdict: "à_revoir", issues: ["étape 2 absente"], missingRisks: [], vagueSteps: [1] },
      revised: true,
      revisions: 1,
    });
    expect(rendered).toContain("DÉFAUTS RÉSIDUELS");
    expect(rendered).toContain("étape 2 absente");
  });
});

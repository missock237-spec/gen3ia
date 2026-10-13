import { describe, expect, it } from "vitest";

/**
 * Outil agent « decision.analyze » — Probability & Odds Decision Engine (Task 140).
 *
 * Verrous :
 *  1. schéma d'entrée strict (probabilités ∈ [0,1], valeurs finies, 1 à 20
 *     issues par option, 1 à 10 options, 500 à 10 000 simulations) ;
 *  2. AUCUN appel LLM : moteur 100 % déterministe et reproductible ;
 *  3. métriques exactes : espérance/variance/écart-type analytiques,
 *     percentiles par interpolation linéaire, CVaR = moyenne des 5 % pires ;
 *  4. normalisation AVERTIE quand la somme des probabilités s'écarte de 1
 *     (± 0,01), erreur française quand la somme est nulle ;
 *  5. DÉTERMINISME : deux exécutions identiques produisent des sorties
 *     strictement égales (deep equal) ;
 *  6. tolérance au risque : averse → CVaR, avide → upside — le classement
 *     s'inverse sur un exemple construit ;
 *  7. sensibilité : influence de chaque probabilité d'issue (±10 %) ;
 *  8. cas dégénérés : issue unique (percentiles exacts, option
 *     déterministe), volatilité élevée signalée.
 */

import { decisionAnalyzeTool } from "./decision-analyze";

const CONTEXT = { userId: "user-1", executionId: "exec-decision-1" };

describe("outil decision.analyze — schéma d'entrée", () => {
  it("applique les défauts : 5 000 simulations, tolérance neutre", () => {
    const parsed = decisionAnalyzeTool.inputSchema.parse({
      options: [{ label: "Option", outcomes: [{ label: "Issue", probability: 1, value: 10 }] }],
    });
    expect(parsed.simulations).toBe(5000);
    expect(parsed.riskTolerance).toBe("neutral");
  });

  it("refuse une probabilité hors [0,1] ou une valeur non finie", () => {
    expect(() =>
      decisionAnalyzeTool.inputSchema.parse({
        options: [{ label: "A", outcomes: [{ label: "x", probability: 1.2, value: 1 }] }],
      }),
    ).toThrow();
    expect(() =>
      decisionAnalyzeTool.inputSchema.parse({
        options: [{ label: "A", outcomes: [{ label: "x", probability: -0.1, value: 1 }] }],
      }),
    ).toThrow();
    expect(() =>
      decisionAnalyzeTool.inputSchema.parse({
        options: [{ label: "A", outcomes: [{ label: "x", probability: 0.5, value: Number.POSITIVE_INFINITY }] }],
      }),
    ).toThrow();
  });

  it("refuse une option sans issue, plus de 20 issues, plus de 10 options, des simulations hors bornes", () => {
    expect(() =>
      decisionAnalyzeTool.inputSchema.parse({ options: [{ label: "A", outcomes: [] }] }),
    ).toThrow();
    expect(() =>
      decisionAnalyzeTool.inputSchema.parse({
        options: [
          {
            label: "A",
            outcomes: Array.from({ length: 21 }, (_, i) => ({ label: `i${i}`, probability: 0.05, value: i })),
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decisionAnalyzeTool.inputSchema.parse({
        options: Array.from({ length: 11 }, (_, i) => ({
          label: `o${i}`,
          outcomes: [{ label: "issue", probability: 1, value: 1 }],
        })),
      }),
    ).toThrow();
    expect(() =>
      decisionAnalyzeTool.inputSchema.parse({
        options: [{ label: "A", outcomes: [{ label: "x", probability: 1, value: 1 }] }],
        simulations: 499,
      }),
    ).toThrow();
    expect(() =>
      decisionAnalyzeTool.inputSchema.parse({
        options: [{ label: "A", outcomes: [{ label: "x", probability: 1, value: 1 }] }],
        simulations: 10_001,
      }),
    ).toThrow();
  });
});

describe("moteur probabiliste déterministe — métriques", () => {
  it("(a) pièce équitable ±10 : espérance 0, écart-type 10, P(perte) ≈ 0,5", async () => {
    const output = await decisionAnalyzeTool.execute(
      {
        options: [
          {
            label: "Pari",
            outcomes: [
              { label: "Pile", probability: 0.5, value: 10 },
              { label: "Face", probability: 0.5, value: -10 },
            ],
          },
        ],
      },
      CONTEXT,
    );

    const option = output.perOption[0];
    expect(option.expectedValue).toBe(0);
    expect(option.stdDev).toBe(10);
    expect(option.probabilityOfLoss).toBeGreaterThan(0.48);
    expect(option.probabilityOfLoss).toBeLessThan(0.52);
    expect(option.p5).toBeLessThanOrEqual(option.cvar5);
    expect(output.ranking).toEqual(["Pari"]);
  });

  it("(b) 80 % +100 / 20 % −100 : espérance 60, écart-type analytique", async () => {
    const output = await decisionAnalyzeTool.execute(
      {
        options: [
          {
            label: "Investissement",
            outcomes: [
              { label: "Hausse", probability: 0.8, value: 100 },
              { label: "Baisse", probability: 0.2, value: -100 },
            ],
          },
        ],
      },
      CONTEXT,
    );

    const option = output.perOption[0];
    expect(option.expectedValue).toBeCloseTo(60, 8);
    expect(option.stdDev).toBeCloseTo(80, 8);
    expect(option.probabilityOfLoss).toBeCloseTo(0.2, 2);
  });

  it("(c) probabilités sommant à 0,9 : avertissement de normalisation, métriques recalées", async () => {
    const output = await decisionAnalyzeTool.execute(
      {
        options: [
          {
            label: "Option floue",
            outcomes: [
              { label: "Gain", probability: 0.72, value: 100 },
              { label: "Perte", probability: 0.18, value: -100 },
            ],
          },
        ],
        simulations: 600,
      },
      CONTEXT,
    );

    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toMatch(/normalisées \(somme 0,9\)/i);
    expect(output.warnings[0]).toContain("Option floue");
    expect(output.perOption[0].warnings).toHaveLength(1);
    // Après normalisation : 0,8 × 100 + 0,2 × (−100) = 60.
    expect(output.perOption[0].expectedValue).toBeCloseTo(60, 8);
  });

  it("(g) somme des probabilités nulle : erreur française explicite", async () => {
    await expect(
      decisionAnalyzeTool.execute(
        {
          options: [
            {
              label: "Option vide",
              outcomes: [
                { label: "A", probability: 0, value: 10 },
                { label: "B", probability: 0, value: -10 },
              ],
            },
          ],
        },
        CONTEXT,
      ),
    ).rejects.toThrow(/somme des probabilités.*« Option vide ».*nulle/);
  });

  it("(h) issue unique : tous les percentiles égaux à la valeur, option déterministe signalée", async () => {
    const output = await decisionAnalyzeTool.execute(
      {
        options: [
          { label: "Fixe", outcomes: [{ label: "Rendement garanti", probability: 1, value: 42 }] },
        ],
        simulations: 600,
      },
      CONTEXT,
    );

    const option = output.perOption[0];
    expect(option.expectedValue).toBe(42);
    expect(option.stdDev).toBe(0);
    expect(option.p5).toBe(42);
    expect(option.cvar5).toBe(42);
    expect(option.upsideP95).toBe(42);
    expect(option.probabilityOfLoss).toBe(0);
    expect(option.warnings.join(" ")).toContain("déterministe");
    expect(output.warnings.join(" ")).toContain("déterministe");
  });
});

describe("moteur probabiliste déterministe — déterminisme et tolérance au risque", () => {
  const CONSTRUCTED = {
    simulations: 2_000,
    options: [
      { label: "Prudent", outcomes: [{ label: "Gain modeste", probability: 1, value: 50 }] },
      {
        label: "Téméraire",
        outcomes: [
          { label: "Jackpot", probability: 0.5, value: 200 },
          { label: "Perte", probability: 0.5, value: -96 },
        ],
      },
    ],
  };

  it("(d) deux exécutions identiques → sorties strictement égales (deep equal)", async () => {
    const first = await decisionAnalyzeTool.execute(
      {
        options: [
          {
            label: "Produit",
            outcomes: [
              { label: "Succès", probability: 0.5, value: 100 },
              { label: "Échec", probability: 0.5, value: -100 },
            ],
          },
          { label: "Fixe", outcomes: [{ label: "Garanti", probability: 1, value: 5 }] },
        ],
        simulations: 800,
        riskTolerance: "seeking",
      },
      CONTEXT,
    );
    const second = await decisionAnalyzeTool.execute(
      {
        options: [
          {
            label: "Produit",
            outcomes: [
              { label: "Succès", probability: 0.5, value: 100 },
              { label: "Échec", probability: 0.5, value: -100 },
            ],
          },
          { label: "Fixe", outcomes: [{ label: "Garanti", probability: 1, value: 5 }] },
        ],
        simulations: 800,
        riskTolerance: "seeking",
      },
      CONTEXT,
    );

    expect(second).toEqual(first);
    expect(first.assumptions.seed).toBe(second.assumptions.seed);
    expect(first.assumptions.seed).toMatch(/^[0-9a-f]+$/);
    expect(first.assumptions.simulations).toBe(800);
    expect(first.assumptions.riskTolerance).toBe("seeking");
  });

  it("(e) averse vs avide de risque : classements inversés sur l'exemple construit", async () => {
    const averse = await decisionAnalyzeTool.execute(
      { ...CONSTRUCTED, riskTolerance: "averse" },
      CONTEXT,
    );
    const seeking = await decisionAnalyzeTool.execute(
      { ...CONSTRUCTED, riskTolerance: "seeking" },
      CONTEXT,
    );

    // Prudent : EV 50, σ 0 — Téméraire : EV 52, σ 148 → l'averse préfère la
    // queue de perte (CVaR −96), l'avide préfère l'upside (P95 200).
    expect(averse.ranking[0]).toBe("Prudent");
    expect(averse.ranking[1]).toBe("Téméraire");
    expect(seeking.ranking[0]).toBe("Téméraire");
    expect(seeking.ranking[1]).toBe("Prudent");

    expect(averse.recommendation).toContain("averse au risque");
    expect(averse.recommendation).toContain("Prudent");
    expect(averse.recommendation).toContain("CVaR à 5 %");
    expect(seeking.recommendation).toContain("en quête de risque");
    expect(seeking.recommendation).toContain("Téméraire");
    expect(seeking.recommendation).toContain("percentile à 95 %");
  });

  it("neutre : le score pondéré EV − 0,25 σ départage l'exemple en faveur du prudent", async () => {
    const neutral = await decisionAnalyzeTool.execute(
      { ...CONSTRUCTED, riskTolerance: "neutral" },
      CONTEXT,
    );
    expect(neutral.ranking[0]).toBe("Prudent");
    expect(neutral.recommendation).toContain("neutre au risque");
  });

  it("(f) sensibilité : les 5 influences dominantes sont calculées (±10 % par issue)", async () => {
    const output = await decisionAnalyzeTool.execute(
      {
        options: [
          {
            label: "Produit",
            outcomes: [
              { label: "Succès", probability: 0.5, value: 100 },
              { label: "Échec", probability: 0.5, value: -100 },
            ],
          },
        ],
        simulations: 500,
      },
      CONTEXT,
    );

    const influences = output.sensitivity.topInfluences;
    expect(influences.length).toBeGreaterThan(0);
    expect(influences.length).toBeLessThanOrEqual(5);
    // EV de base 0 : +10 % sur Succès ⇒ 0,55 × 100 + 0,45 × (−100) = +10 ;
    // −10 % ⇒ −10. Les deux issues sont symétriques (magnitude 10).
    const success = influences.find((influence) => influence.outcomeLabel === "Succès");
    expect(success).toBeDefined();
    expect(success?.optionLabel).toBe("Produit");
    expect(success?.deltaHigh).toBeCloseTo(10, 6);
    expect(success?.deltaLow).toBeCloseTo(-10, 6);
  });

  it("signale la volatilité élevée (CV > 2) dans les avertissements", async () => {
    const output = await decisionAnalyzeTool.execute(
      {
        options: [
          {
            label: "Loterie",
            outcomes: [
              { label: "Gagnant", probability: 0.49, value: 100 },
              { label: "Perdant", probability: 0.51, value: -100 },
            ],
          },
        ],
        simulations: 500,
      },
      CONTEXT,
    );

    expect(output.warnings.join(" ")).toMatch(/volatilit[ée] [ée]lev[ée]e/);
    expect(output.perOption[0].warnings.join(" ")).toMatch(/volatilit[ée] [ée]lev[ée]e/);
  });
});

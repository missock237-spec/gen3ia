import { describe, expect, it } from "vitest";

import {
  buildGroundedContext,
  extractCitations,
  groundingReport,
  groundingWarning,
} from "./grounding";

describe("buildGroundedContext — contexte numéroté", () => {
  it("retourne undefined sans sources", () => {
    expect(buildGroundedContext([])).toBeUndefined();
    expect(buildGroundedContext([{ title: "x", content: "  " }])).toBeUndefined();
  });

  it("numérote les sources et impose la règle de citation", () => {
    const context = buildGroundedContext([
      { title: "Contrat 2024", content: "Le délai de préavis est de trois mois.", location: "page 4" },
      { title: "Politique RH", content: "Les congés se demandent via le portail." },
    ]);
    expect(context).toContain("[1] Contrat 2024 (page 4)");
    expect(context).toContain("[2] Politique RH");
    expect(context).toContain("n'invente RIEN");
  });
});

describe("extractCitations — références citées", () => {
  it("extrait les numéros uniques et triés", () => {
    expect(extractCitations("Fait A [2], fait B [1], rappel [2].")).toEqual([1, 2]);
    expect(extractCitations("Aucune citation ici.")).toEqual([]);
  });

  it("ignore les plages absurdes", () => {
    expect(extractCitations("[999] et [0]")).toEqual([]);
  });
});

describe("groundingReport — rapport d'ancrage", () => {
  it("couverture parfaite quand tout fait est cité", () => {
    const report = groundingReport(
      "Le préavis est de trois mois [1]. En 2024, la politique le confirme [2].",
      2,
    );
    expect(report.cited).toEqual([1, 2]);
    expect(report.unsupportedClaims).toHaveLength(0);
    expect(report.factCoverage).toBe(1);
    expect(report.suspiciousCitations).toBe(false);
  });

  it("signale les phrases factuelles sans citation", () => {
    const report = groundingReport(
      "Le délai est de 90 jours. Selon l'étude interne, 42% des cas échouent. Voici votre réponse.",
      2,
    );
    expect(report.unsupportedClaims.length).toBeGreaterThanOrEqual(1);
    expect(report.factCoverage).toBeLessThan(1);
  });

  it("détecte les citations hors plage (suspicious)", () => {
    const report = groundingReport("Fait établi en 2023 [5].", 2);
    expect(report.suspiciousCitations).toBe(true);
  });

  it("conversationnel pur : couverture neutre à 1", () => {
    const report = groundingReport("Bonjour ! Voici votre réponse.", 0);
    expect(report.factCoverage).toBe(1);
    expect(report.unsupportedClaims).toHaveLength(0);
  });
});

describe("groundingWarning — avertissement prêt à afficher", () => {
  it("undefined si le rapport est sain", () => {
    expect(groundingWarning({ cited: [1], unsupportedClaims: [], factCoverage: 1, suspiciousCitations: false })).toBeUndefined();
  });

  it("signale les défauts", () => {
    const warning = groundingWarning({
      cited: [3],
      unsupportedClaims: ["Le délai est de 90 jours."],
      factCoverage: 0.2,
      suspiciousCitations: true,
    });
    expect(warning).toContain("n'existent pas");
    expect(warning).toContain("sans source");
  });
});

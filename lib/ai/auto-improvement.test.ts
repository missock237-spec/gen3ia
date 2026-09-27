import { describe, expect, it } from "vitest";

import { assessComplexity } from "./auto-improvement";

describe("assessComplexity — évaluation déterministe (rapide, sans LLM)", () => {
  it("une question simple reste simple", () => {
    const result = assessComplexity("Bonjour, qui es-tu ?");
    expect(result.level).toBe("simple");
    expect(result.beyondMastered).toBe(false);
  });

  it("une demande multi-parties avec automatisation et sous-agents monte en complexité", () => {
    const result = assessComplexity(
      "Analyse ce fichier CSV, crée un rapport avec graphiques, puis automatise un workflow hebdomadaire et délègue à des sous-agents pour la veille concurrentielle.",
    );
    expect(["avancee", "complexe", "extreme"]).toContain(result.level);
    expect(result.score).toBeGreaterThanOrEqual(40);
  });

  it("le score est plafonné à 100", () => {
    const long = Array(30).fill("automatise un workflow api intégration analyse rapport présentation ?").join(" ");
    expect(assessComplexity(long).score).toBeLessThanOrEqual(100);
  });

  it("beyondMastered s'active au-delà du niveau maîtrisé", () => {
    const message = "Crée une application web complète avec intégration API et tableau de bord.";
    const assessment = assessComplexity(message, 0);
    expect(assessComplexity(message, 95).beyondMastered).toBe(false);
    // Cohérence : plus le seuil maîtrisé est bas, plus le mode évolution s'active.
    expect(assessment.beyondMastered).toBe(assessment.score > 8);
  });

  it("les listes à puces augmentent la complexité", () => {
    const bulleted = "- étape un\n- étape deux\n- étape trois\n- étape quatre\n- étape cinq";
    expect(assessComplexity(bulleted).score).toBeGreaterThan(assessComplexity("étape un étape deux étape trois").score);
  });
});

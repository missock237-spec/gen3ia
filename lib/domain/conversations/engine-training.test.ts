import { describe, expect, it } from "vitest";

import { estIntentionEntrainement, extraireConnaissance } from "./engine-training";

/**
 * Tests du tour « entraînement depuis le chat » — détection déterministe
 * (aucune variance LLM) et extraction de la connaissance enseignée.
 */
describe("engine-training — détection d'intention d'entraînement", () => {
  it("détecte « apprends que » (FR)", () => {
    expect(estIntentionEntrainement("Apprends que KPI signifie indicateur clé de performance")).toBe(true);
    expect(estIntentionEntrainement("apprends ça que la TVA est une taxe")).toBe(true);
  });

  it("détecte « retiens que », « note que », « souviens-toi que »", () => {
    expect(estIntentionEntrainement("Retiens que notre slogan est Zéro friction")).toBe(true);
    expect(estIntentionEntrainement("Note que le SLA est de 99,9 %")).toBe(true);
    expect(estIntentionEntrainement("Souviens-toi que le déploiement se fait par GitHub Actions")).toBe(true);
  });

  it("détecte « entraîne-toi » et l'anglais", () => {
    expect(estIntentionEntrainement("Entraîne-toi sur les abréviations médicales")).toBe(true);
    expect(estIntentionEntrainement("Learn that our office closes at 6pm")).toBe(true);
  });

  it("ne déclenche PAS sur une question normale", () => {
    expect(estIntentionEntrainement("Qu'est-ce qu'un KPI ?")).toBe(false);
    expect(estIntentionEntrainement("Génère une image photoréaliste d'un léopard")).toBe(false);
    expect(estIntentionEntrainement("apprendre le français est difficile")).toBe(false);
  });

  it("extrait la connaissance sans le préfixe", () => {
    expect(extraireConnaissance("Apprends que MVP veut dire produit minimum viable")).toBe(
      "MVP veut dire produit minimum viable",
    );
    expect(extraireConnaissance("Retiens que le mot de passe admin est archivé en coffre")).toBe(
      "le mot de passe admin est archivé en coffre",
    );
  });

  it("retourne null quand rien n'est extractible", () => {
    expect(extraireConnaissance("Bonjour")).toBeNull();
    expect(extraireConnaissance("")).toBeNull();
  });
});

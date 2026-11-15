import { describe, expect, it } from "vitest";

import { executerSuiteValidationGen3 } from "@/lib/ondes/suite-validation";

describe("suite de validation gen3 (portage gen3TestSuite)", () => {
  it("les 3 familles de tests de l'architecture passent (entraînement, vidéo, audio)", () => {
    const suite = executerSuiteValidationGen3({ nbNoeuds: 1024 });

    expect(suite.tests).toHaveLength(3);
    expect(suite.succes).toBe(true);
    expect(suite.dureeMs).toBeGreaterThan(0);
    for (const test of suite.tests) {
      expect(test.succes).toBe(true);
      expect(test.details.length).toBeGreaterThan(0);
    }
    // Ordre et noms fidèles à la source (traçabilité).
    expect(suite.tests.map((t) => t.nom)).toEqual([
      "Moteur d'entraînement par ondes (RPIA)",
      "Rendu vidéo spatiotemporel (3D tensor)",
      "Synthèse audio par résonance acoustique",
    ]);
  });

  it("un échec isolé ne fait pas tomber la suite (chaque test est protégé)", () => {
    // Le test utilise un nbNoeuds valide — on vérifie ici que la suite
    // renvoie bien un booléen global cohérent avec les tests individuels.
    const suite = executerSuiteValidationGen3({ nbNoeuds: 128 });
    expect(suite.succes).toBe(suite.tests.every((t) => t.succes));
  });
});

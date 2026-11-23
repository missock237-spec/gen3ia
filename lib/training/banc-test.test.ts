import { describe, expect, it } from "vitest";

import { bancTestInterne, SEUILS_BANC_TEST } from "./banc-test";
import { adapterPour } from "./adaptateurs-ia";
import { genererExemplesClassification } from "./synthetique";

/**
 * BANC DE TEST INTERNE — entraîner sur train, évaluer (test = généralisation
 * ou train = rétention selon la famille), verdict honnête contre seuil
 * explicite. Exigence produit : gen3 teste le modèle DIRECTEMENT EN INTERNE
 * après l'entraînement.
 */
describe("banc-test — cycle entraîner → tester → verdict", () => {
  it("MLP entraîné sur clusters séparables → verdict CONFORME avec score ≥ seuil", async () => {
    const { exemples } = genererExemplesClassification({ nombre: 300, classes: 3, dimensions: 2, graine: 88 });
    const rapport = await bancTestInterne({
      adaptateur: adapterPour({ famille: "tenseur-mlp", architecture: { entrees: 2, caches: [10], sorties: 3 }, graine: 88 }),
      donnees: { classification: exemples },
      ratioTest: 0.25,
      epoques: 150,
      graine: 88,
    });
    expect(rapport.verdict).toBe("conforme");
    expect(rapport.score).toBeGreaterThanOrEqual(rapport.seuil);
    expect(rapport.trainCount + rapport.testCount).toBe(300);
    expect(rapport.testCount).toBe(75);
    expect(rapport.entrainement.convergence).toBe(true);
    expect(rapport.dureeMs).toBeGreaterThan(0);
    expect(rapport.evaluationEchantillon).toBe("test");
  });

  it("MLP avec labels NON apprenables → verdict INSUFFISANT assumé (jamais prêt à tort)", async () => {
    const { exemples } = genererExemplesClassification({ nombre: 160, classes: 4, dimensions: 6, graine: 21 });
    const nonApprenable = exemples.map((e, i) => ({ ...e, label: `classe-${((i * 7 + 3) % 4) + 1}` }));
    const rapport = await bancTestInterne({
      adaptateur: adapterPour({ famille: "tenseur-mlp", architecture: { entrees: 6, caches: [8], sorties: 4 }, graine: 21 }),
      donnees: { classification: nonApprenable },
      epoques: 60, // même bien entraîné : les labels ne dépendent pas des entrées
      graine: 21,
    });
    expect(rapport.verdict).toBe("insuffisant");
    expect(rapport.details).toMatch(/ne PAS déployer/);
  });

  it("données insuffisantes (< 4) : refus honnête, pas de split fantôme", async () => {
    await expect(
      bancTestInterne({
        adaptateur: adapterPour({ famille: "tenseur-mlp", architecture: { entrees: 2, caches: [4], sorties: 2 }, graine: 5 }),
        donnees: {
          classification: [
            { entrees: [0, 1], label: "a" },
            { entrees: [1, 0], label: "b" },
          ],
        },
      }),
    ).rejects.toThrow(/au moins 4 échantillons/);
  });

  it("seuils explicites par famille (contrat du banc)", () => {
    expect(SEUILS_BANC_TEST["tenseur-mlp"]).toBe(0.9);
    expect(SEUILS_BANC_TEST["cortex-langagier"]).toBe(0.9);
    expect(SEUILS_BANC_TEST["onde-rpia"]).toBe(0.8);
  });
});

import { describe, it, expect, afterAll } from "vitest";

import { lancerEntrainement, getDernierJob } from "./job";
import { resetBrain } from "../runtime";

/**
 * JOB D'ENTRAÎNEMENT SUR LES 18 DOMAINES — source « domaines » : charge les
 * échantillons réels des datasets commis, entraîne la couche des domaines
 * (pools 100-135), enrichit le cortex langagier et persiste le cerveau.
 */
describe("Job d'entraînement « domaines » (E2E)", () => {
  it("entraîne la couche des domaines sur les datasets commis", async () => {
    const job = lancerEntrainement({
      source: "domaines",
      epochs: 1,
      maxParDomaine: 10,
    });

    expect(job.status).toBe("en_cours");
    expect(job.source).toBe("domaines");

    const debut = Date.now();
    while (Date.now() - debut < 120_000) {
      const courant = getDernierJob();
      if (courant && courant.status !== "en_cours") break;
      await new Promise((resoudre) => setTimeout(resoudre, 200));
    }

    const final = getDernierJob();
    expect(final).not.toBeNull();
    expect(final!.status).toBe("termine");
    expect(final!.nbEchantillonsDomaines).toBeGreaterThan(0);
    expect(final!.statsDomaines).toBeDefined();
    expect(final!.statsDomaines!.fichiersAbsents).toEqual([]);
    // Les 18 domaines sont représentés dans le jeu réel.
    expect(Object.keys(final!.statsDomaines!.parDomaine)).toHaveLength(18);
    // Rapport de la couche domaine présent et honnête.
    expect(final!.rapportDomaines).toBeDefined();
    expect(final!.rapportDomaines!.samples).toBeGreaterThan(0);
    expect(final!.rapportDomaines!.accuracyTest).toBeGreaterThanOrEqual(0);
    // Le cortex langagier a reçu les paires de domaine.
    expect(final!.langage).toBeDefined();
    expect(final!.langage!.pairesAjoutees).toBeGreaterThan(0);
  }, 150_000);

  afterAll(() => {
    resetBrain();
  });
});

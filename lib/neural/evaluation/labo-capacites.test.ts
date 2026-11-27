/**
 * Tests — LABORATOIRE DE CAPACITÉS (évaluation indépendante A/B réelle).
 *
 * Ce que le rapport doit PROUVER (pas supposer) :
 *  1. les trois épreuves « tout-flou » (f1, f2, f3) échouent SANS la couche
 *     morphologique et réussissent AVEC — le gain est mesuré ;
 *  2. la calibration du rejet est INTACTE dans les deux modes (aucun faux
 *     positif introduit par le rapprochement flou) ;
 *  3. le taux global « après » est ≥ « avant » ;
 *  4. le laboratoire est déterministe (deux exécutions identiques).
 */

import { describe, expect, it } from "vitest";

import { EPREUVES_LABO } from "./jeu-evaluation";
import { construireCortexLabo, executerLabo } from "./labo-capacites";

describe("laboratoire de capacités — mesure A/B réelle", () => {
  const rapport = executerLabo("2026-11-27T00:00:00.000Z");

  it("couvre les 5 familles avec 30 épreuves et 17 paires d'apprentissage", () => {
    expect(rapport.jeu).toEqual({ pairesApprentissage: 17, epreuves: 30 });
    expect(rapport.avant.parFamille).toHaveLength(5);
    for (const famille of rapport.apres.parFamille) {
      expect(famille.total).toBeGreaterThan(0);
      expect(famille.taux).toBeGreaterThanOrEqual(0);
      expect(famille.taux).toBeLessThanOrEqual(1);
    }
  });

  it("MESURE le gain morphologique : f1/f2/f3 échouent avant, réussissent après", () => {
    for (const id of ["f1", "f2", "f3"]) {
      const avant = rapport.avant.epreuves.find((e) => e.id === id)!;
      const apres = rapport.apres.epreuves.find((e) => e.id === id)!;
      expect(avant.reussi, `${id} doit échouer sans la couche floue`).toBe(false);
      expect(apres.reussi, `${id} doit réussir avec la couche floue`).toBe(true);
    }
    expect(rapport.deltaEpreuves.map((d) => d.id)).toEqual(expect.arrayContaining(["f1", "f2", "f3"]));
  });

  it("préserve la calibration du rejet dans les DEUX modes (aucun faux positif)", () => {
    for (const item of EPREUVES_LABO.filter((i) => i.rejetAttendu)) {
      const avant = rapport.avant.epreuves.find((e) => e.id === item.id)!;
      const apres = rapport.apres.epreuves.find((e) => e.id === item.id)!;
      expect(avant.reussi, `rejet avant attendu : ${item.id}`).toBe(true);
      expect(apres.reussi, `rejet après attendu : ${item.id}`).toBe(true);
    }
  });

  it("ne régresse nulle part : le taux global 'après' est ≥ 'avant'", () => {
    expect(rapport.apres.tauxGlobal).toBeGreaterThanOrEqual(rapport.avant.tauxGlobal);
    expect(rapport.apres.tauxGlobal).toBeGreaterThanOrEqual(0.8);
  });

  it("est déterministe : deux exécutions produisent le même rapport", () => {
    const second = executerLabo("2026-11-27T00:00:00.000Z");
    expect(second.avant.tauxGlobal).toBe(rapport.avant.tauxGlobal);
    expect(second.apres.tauxGlobal).toBe(rapport.apres.tauxGlobal);
    expect(second.deltaEpreuves).toEqual(rapport.deltaEpreuves);
  });

  it("les épreuves en échec portent un diagnostic FR actionnable", () => {
    for (const epreuve of [...rapport.avant.epreuves, ...rapport.apres.epreuves]) {
      if (!epreuve.reussi) {
        expect(typeof epreuve.echec).toBe("string");
        expect(epreuve.echec!.length).toBeGreaterThan(0);
      }
    }
  });

  it("un cortex du laboratoire répond réellement après apprentissage (sanity)", () => {
    const cortex = construireCortexLabo();
    const reponse = cortex.repondre("quelle est la recette du tajine de la maison");
    expect(reponse).not.toBeNull();
    expect(reponse!.texte).toContain("pruneaux");
  });
});

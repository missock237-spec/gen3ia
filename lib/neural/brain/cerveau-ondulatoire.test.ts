import { describe, expect, it } from "vitest";
import { CerveauOndulatoireGen3 } from "./cerveau-ondulatoire";

describe("CerveauOndulatoireGen3", () => {
  it("apprend et rappelle une association sur CPU", () => {
    const cerveau = new CerveauOndulatoireGen3({ taille: 24, budgetActif: 5, epoquesParAssociation: 3 });
    const apprentissage = cerveau.apprendre("Bonjour Gen3", "Bonjour !");
    const resultat = cerveau.percevoir("  BONJOUR   GEN3 ");
    expect(apprentissage.epoquesRPIA).toBe(3);
    expect(Number.isFinite(apprentissage.erreurRPIAFinale)).toBe(true);
    expect(resultat.sortie).toBe("Bonjour !");
    expect(resultat.mode).toBe("RAPPEL_EXACT");
    expect(resultat.unitesSourceActives).toBeLessThanOrEqual(5);
    expect(resultat.evenementsSynaptiques).toBeGreaterThan(0);
  });
});

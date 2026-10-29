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

  it("ne répond pas à une demande inconnue", () => {
    const cerveau = new CerveauOndulatoireGen3({ taille: 24, budgetActif: 4, epoquesParAssociation: 2, seuilRappel: 1 });
    cerveau.apprendre("question apprise", "réponse mémorisée");
    const resultat = cerveau.percevoir("demande totalement différente");
    expect(resultat.sortie).toBeNull();
    expect(resultat.mode).toBe("INCONNU");
    expect(resultat.confiance).toBe(0);
  });

  it("permet un rappel lexical approximatif uniquement quand il est explicitement activé", () => {
    const cerveau = new CerveauOndulatoireGen3({
      taille: 128,
      budgetActif: 8,
      epoquesParAssociation: 2,
      seuilRappel: 0.6,
    });
    cerveau.apprendre("Quelle est la capitale du Cameroun ?", "Yaoundé");
    const proche = cerveau.percevoir("Capitale du Cameroun");
    const inconnue = cerveau.percevoir("La météo demain à Tokyo");

    expect(proche.mode).toBe("RAPPEL_ASSOCIATIF");
    expect(proche.sortie).toBe("Yaoundé");
    expect(proche.confiance).toBeGreaterThanOrEqual(0.6);
    expect(inconnue.sortie).toBeNull();
    expect(inconnue.mode).toBe("INCONNU");
  });

  it("remplace une entrée normalisée sans dupliquer le souvenir", () => {
    const cerveau = new CerveauOndulatoireGen3({ taille: 24, budgetActif: 4, epoquesParAssociation: 2 });
    const premier = cerveau.apprendre("Bonjour", "Salut.");
    const second = cerveau.apprendre("  BONJOUR  ", "Bonjour de nouveau.");
    expect(second.idMemoire).toBe(premier.idMemoire);
    expect(second.remplaceMemoire).toBe(true);
    expect(cerveau.statistiques().associationsMemorisees).toBe(1);
    expect(cerveau.percevoir("bonjour").sortie).toBe("Bonjour de nouveau.");
  });

  it("borne la mémoire à long terme", () => {
    const cerveau = new CerveauOndulatoireGen3({ taille: 16, budgetActif: 3, capaciteMemoire: 2, epoquesParAssociation: 1 });
    cerveau.apprendre("première entrée", "première réponse");
    cerveau.apprendre("deuxième entrée", "deuxième réponse");
    cerveau.apprendre("troisième entrée", "troisième réponse");
    expect(cerveau.statistiques().associationsMemorisees).toBe(2);
    expect(cerveau.percevoir("première entrée").sortie).toBeNull();
    expect(cerveau.percevoir("troisième entrée").sortie).toBe("troisième réponse");
  });

  it("refuse une horloge ondulatoire corrompue sans toucher au cerveau actif", () => {
    const cerveau = new CerveauOndulatoireGen3({ taille: 24, budgetActif: 4, epoquesParAssociation: 2, graine: 17 });
    cerveau.apprendre("question stable", "réponse stable");
    const checkpoint = cerveau.exporterEtat();
    checkpoint.souvenirs[0].etatOnde.pasDeTemps = Number.NaN;

    expect(() => cerveau.importerEtat(checkpoint)).toThrow(/horloge RPIA/);
    expect(cerveau.percevoir("question stable").sortie).toBe("réponse stable");
  });

  it("conserve les associations après export et restauration", () => {
    const source = new CerveauOndulatoireGen3({ taille: 24, budgetActif: 4, epoquesParAssociation: 2, graine: 17 });
    source.apprendre("Capitale du Cameroun", "Yaoundé");
    const checkpoint = source.exporterEtat();
    const destination = new CerveauOndulatoireGen3({ taille: 24, budgetActif: 4, epoquesParAssociation: 2, graine: 17 });
    destination.importerEtat(checkpoint);
    expect(destination.percevoir("Capitale du Cameroun").sortie).toBe("Yaoundé");
    expect(destination.statistiques().synapsesApprises).toBe(source.statistiques().synapsesApprises);
  });
});

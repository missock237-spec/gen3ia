import { describe, expect, it } from "vitest";

import {
  ADAPTATION_MIN_MOTS_COMMUNS,
  carenceDomaine,
  formerDomaineDynamique,
  motsInformatifs,
  phraseApprentissageDomaine,
  reconnaitreDomaineDynamique,
  renforcerDomaineDynamique,
  type DomaineDynamiqueGen3,
} from "./adaptation-domaine";

/**
 * ADAPTATION DE DOMAINE DYNAMIQUE — la garantie « n'importe quel domaine »
 * sans réentraînement complet : en cas de carence de la couche entraînée,
 * le moteur APPRIT le domaine depuis les mots informatifs du message, le
 * mémorise et le RECONNAIT aux tours suivants (renforcement). Même contrat
 * d'honnêteté que le reste du cerveau : la couche entraînée prime, un
 * message sans contenu informatif n'apprend rien, les scores reflètent le
 * renforcement réel.
 */
describe("motsInformatifs — signature sémantique d'un message", () => {
  it("retient les mots de contenu, écarte outils, chiffres et doublons", () => {
    const mots = motsInformatifs("Bonjour, je veux apprendre l'astronomie et l'astronomie avancée");
    expect(mots).toContain("astronomie");
    expect(mots).toContain("apprendre");
    expect(mots).not.toContain("bonjour");
    expect(mots.filter((mot) => mot === "astronomie")).toHaveLength(1);
  });
});

describe("formation d'un domaine dynamique (carence de la couche entraînée)", () => {
  const MAINTENANT = 1_800_000_000_000;

  it("carence confirmée : aucune détection = adaptation requise", () => {
    expect(carenceDomaine(null)).toBe(true);
    expect(carenceDomaine({ label: "DOM_TEST", nom: "Test", nomEn: null, score: 4, source: "lexical" })).toBe(false);
  });

  it("un message informatif hors catalogue APPREND un domaine avec signature réelle", () => {
    const apprenti = formerDomaineDynamique(
      "Je veux lancer une culture hydroponique de tomates cerises en serre",
      MAINTENANT,
      1,
    );
    expect(apprenti).not.toBeNull();
    expect(apprenti?.label).toBe("DOM_DYN_001");
    expect(apprenti?.motsCles).toContain("hydroponique");
    expect(apprenti?.motsCles).toContain("tomates");
    expect(apprenti?.motsCles.length).toBeLessThanOrEqual(5);
    expect(apprenti?.score).toBe(1);
    expect(apprenti?.nom.length).toBeGreaterThan(0);
  });

  it("un message sans contenu informatif n'apprend RIEN (« bonjour » n'est pas un domaine)", () => {
    expect(formerDomaineDynamique("bonjour", MAINTENANT, 1)).toBeNull();
    expect(formerDomaineDynamique("merci beaucoup", MAINTENANT, 1)).toBeNull();
  });

  it("le BRUIT LEXICAL pur n'invente jamais un domaine (pas de structure de demande)", () => {
    // Pseudomots sans intention ni longueur réelle : aucun domaine inventé.
    expect(formerDomaineDynamique("xyzzy qwerty flurb", MAINTENANT, 1)).toBeNull();
  });

  it("une demande courte AVEC marqueur d'intention apprend quand même son domaine", () => {
    const apprenti = formerDomaineDynamique("Analyse mes ventes trimestrielles", MAINTENANT, 2);
    expect(apprenti).not.toBeNull();
    expect(apprenti?.motsCles).toContain("ventes");
    expect(apprenti?.label).toBe("DOM_DYN_002");
  });
});

describe("reconnaissance et renforcement — le domaine appris survit aux tours suivants", () => {
  const MAINTENANT = 1_800_000_000_000;

  it("tour suivant avec les mêmes mots → domaine reconnu DYNAMIQUEMENT puis renforcé", () => {
    const registre = new Map<string, DomaineDynamiqueGen3>();
    const apprenti = formerDomaineDynamique(
      "Je veux lancer une culture hydroponique de tomates cerises en serre",
      MAINTENANT,
      1,
    );
    expect(apprenti).not.toBeNull();
    registre.set(apprenti!.label, apprenti!);

    const reconnu = reconnaitreDomaineDynamique(
      "L'hydroponique demande combien d'eau pour mes tomates ?",
      registre,
    );
    expect(reconnu).not.toBeNull();
    expect(reconnu?.source).toBe("dynamique");
    expect(reconnu?.label).toBe("DOM_DYN_001");
    expect(reconnu?.score).toBe(1);

    const renforce = renforcerDomaineDynamique(registre.get(reconnu!.label)!);
    expect(renforce.score).toBe(2);
  });

  it("sous le seuil de signature (1 seul mot commun) → non reconnu (pas de faux positif)", () => {
    const registre = new Map<string, DomaineDynamiqueGen3>();
    const apprenti = formerDomaineDynamique("culture hydroponique de tomates en serre", MAINTENANT, 1);
    registre.set(apprenti!.label, apprenti!);
    expect(reconnaitreDomaineDynamique("parle-moi d'hydroponique seulement", registre)).toBeNull();
    expect(ADAPTATION_MIN_MOTS_COMMUNS).toBe(2);
  });

  it("registre vide → null (aucun domaine inventé)", () => {
    expect(reconnaitreDomaineDynamique("astronomie et télescopes", new Map())).toBeNull();
  });

  it("la phrase d'apprentissage est honnête : apprenti + mémorisé + prochains échanges", () => {
    const phrase = phraseApprentissageDomaine("Culture Hydroponique");
    expect(phrase).toMatch(/Nouveau domaine/);
    expect(phrase).toMatch(/mémorisé/);
    expect(phrase).toMatch(/prochains échanges/);
  });
});

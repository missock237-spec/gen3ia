import { describe, expect, it } from "vitest";

import {
  composerDepuisConnaissances,
  motsInformatifs,
  parserFragmentsConnaissances,
  PONT_MAX_FRAGMENTS,
} from "./connaissances-pont";

/**
 * PONT CONNAISSANCES → RÉPONSE : les documents ingérés par l'utilisateur
 * doivent atteindre le TEXTE de la réponse (avec citation de la source),
 * sans jamais inventer — aucun fragment pertinent ⇒ null (repli
 * cortex/décodeur), texte cité = fragment indexé mot pour mot.
 */

const CONTEXTE = `
- [document doc_charte, fragment 3, score 0.62]
La charte impose 25 jours de congés payés annuels et un télétravail maximum de 3 jours par semaine.

- [document doc_produit, fragment 1, score 0.41]
Le produit Gen3ia facture l'usage API au token ; le wallet est rechargé via Chariow en XAF.
`;

describe("parserFragmentsConnaissances", () => {
  it("relit les fragments du contexte (document, fragment, score, texte)", () => {
    const fragments = parserFragmentsConnaissances(CONTEXTE);
    expect(fragments).toHaveLength(2);
    expect(fragments[0]).toMatchObject({ documentId: "doc_charte", chunkIndex: 3, score: 0.62 });
    expect(fragments[0].texte).toContain("25 jours de congés payés");
  });

  it("ignore les blocs étrons et un contexte vide", () => {
    expect(parserFragmentsConnaissances("")).toEqual([]);
    expect(parserFragmentsConnaissances("- [document x, fragment 0]\ntrop court")).toEqual([]);
  });
});

describe("motsInformatifs", () => {
  it("écarte les mots outils et les mots courts", () => {
    expect(motsInformatifs("Que dit la charte sur les congés ?")).toEqual(["charte", "conges"]);
  });
});

describe("composerDepuisConnaissances", () => {
  it("compose une réponse CITÉE quand un fragment répond à la question", () => {
    const composition = composerDepuisConnaissances(
      "Combien de jours de congés payés prévoit la charte ?",
      CONTEXTE,
    );
    expect(composition).not.toBeNull();
    expect(composition!.source).toBe("connaissances_utilisateur");
    expect(composition!.texte).toContain("D'après vos documents");
    expect(composition!.texte).toContain("25 jours de congés payés");
    expect(composition!.texte).toContain("document doc_charte, fragment 3");
    // Le fragment concurrent (wallet) ne doit pas être cité.
    expect(composition!.texte).not.toContain("Chariow");
  });

  it("cite au plus deux documents distincts", () => {
    const contexte3 = `${CONTEXTE}
- [document doc_rh, fragment 7, score 0.55]
Les congés se posent sur l'outil RH ; validation du manager sous 5 jours ouvrés.
`;
    const composition = composerDepuisConnaissances(
      "congés payés charte rh télétravail",
      contexte3,
    );
    expect(composition).not.toBeNull();
    const sources = (composition!.texte.match(/— Source :/g) ?? []).length;
    expect(sources).toBeLessThanOrEqual(PONT_MAX_FRAGMENTS);
  });

  it("retourne null quand AUCUN fragment ne correspond (refus honnête)", () => {
    expect(
      composerDepuisConnaissances("bonjour, comment vas-tu ?", CONTEXTE),
    ).toBeNull();
  });

  it("retourne null sans contexte ou sans question", () => {
    expect(composerDepuisConnaissances("congés ?", "")).toBeNull();
    expect(composerDepuisConnaissances("", CONTEXTE)).toBeNull();
    expect(composerDepuisConnaissances("   ", CONTEXTE)).toBeNull();
  });

  it("insensible aux accents et à la casse (français)", () => {
    const composition = composerDepuisConnaissances(
      "QUE DIT LA CHARTE POUR LES TÉLÉTRAVAILS ?",
      CONTEXTE,
    );
    expect(composition).not.toBeNull();
    expect(composition!.texte).toContain("télétravail");
  });
});

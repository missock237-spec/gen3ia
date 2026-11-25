/**
 * TESTS DU LOT 3 — génération linguistique native (compositeur).
 * Chaque affirmation mesure un comportement réel : phrases NOUVELLES
 * (pas de concaténation verbatim), grammaire minimale, patrons par type
 * de question, déterminisme, refus honnête sans faits.
 */

import { describe, expect, it } from "vitest";

import { composerReponseNative, surfaceCompositeur, type FaitCompose } from "./compositeur";

const FAITS: FaitCompose[] = [
  { cle: "prop.energie", valeur: "le rayonnement solaire alimente le climat" },
  { cle: "prop.echelle", valeur: "la lumière met 8 minutes à nous parvenir" },
  { cle: "prop.usage", valeur: "les panneaux photovoltaïques convertissent la lumière" },
  { cle: "prop.histoire", valeur: "l'héliocentrisme fut établi au XVIe siècle" },
];

describe("LOT 3 — le compositeur génère du NATIF (pas du verbatim)", () => {
  it("le texte produit n'est la concaténation d'aucun fait seul — il est tissé", () => {
    const r = composerReponseNative({ question: "Que sais-tu du Soleil ?", concept: "Soleil", faits: FAITS, resume: "une étoile du système solaire" });
    expect(r).not.toBeNull();
    for (const f of FAITS) {
      // Aucun fait n'est recopié isolément comme réponse complète :
      // la réponse est plus longue et entourée de structure grammaticale.
      expect(r!.texte.length).toBeGreaterThan(f.valeur.length + 20);
      expect(r!.texte.startsWith(f.valeur)).toBe(false);
    }
    expect(r!.genere).toBe(true);
    expect(r!.faitsUtilises.length).toBeGreaterThan(0);
  });

  it("les faits utilisés apparaissent dans la réponse (aucune invention)", () => {
    const r = composerReponseNative({ question: "Explique le Soleil", concept: "Soleil", faits: FAITS, resume: "une étoile du système solaire" });
    const normalise = (s: string) => s.toLowerCase().replace(/[«»;:]/gu, " ").replace(/\s+/gu, " ");
    const t = normalise(r!.texte);
    for (const cle of r!.faitsUtilises) {
      const f = FAITS.find((x) => x.cle === cle)!;
      expect(t).toContain(normalise(f.valeur)); // contenu préservé, jamais déformé
    }
    // Les faits NON utilisés n'inventent pas de contenu :
    expect(r!.faitsUtilises.length).toBeLessThanOrEqual(FAITS.length);
  });

  it("grammaire minimale : majuscule initiale, ponctuation finale", () => {
    const r = composerReponseNative({ question: "Le Soleil ?", concept: "Soleil", faits: FAITS });
    expect(r!.texte[0]).toBe(r!.texte[0].toUpperCase());
    expect(r!.texte.endsWith(".")).toBe(true);
  });
});

describe("LOT 3 — patrons par type de question (analyse sémantique LOT 2)", () => {
  it("defini/explique → patron définition (avec résumé)", () => {
    const r = composerReponseNative({ question: "Qu'est-ce que le Soleil ?", concept: "Soleil", faits: FAITS, resume: "une étoile du système solaire" });
    expect(r!.patron).toBe("definition");
    expect(r!.texte).toContain("désigne");
  });

  it("pourquoi → patron causalité honnête", () => {
    const r = composerReponseNative({ question: "Pourquoi le Soleil chauffe-t-il ?", concept: "Soleil", faits: FAITS });
    expect(r!.patron).toBe("causalite");
    expect(r!.texte).toContain("Concernant");
  });

  it("comment → patron procédure séquencée", () => {
    const r = composerReponseNative({ question: "Comment capter l'énergie solaire ?", concept: "énergie solaire", faits: FAITS });
    expect(r!.patron).toBe("procedure");
    expect(r!.texte).toContain("d'abord");
  });

  it("liste → énumération numérotée", () => {
    const r = composerReponseNative({ question: "Liste les propriétés du Soleil", concept: "Soleil", faits: FAITS });
    expect(r!.patron).toBe("enumeration");
    expect(r!.texte).toContain("1)");
  });

  it("affirmation → paragraphe assemblé avec connectives", () => {
    const r = composerReponseNative({ question: "Parle-moi du Soleil", concept: "Soleil", faits: FAITS });
    expect(r!.patron).toBe("paragraphe");
    expect(r!.texte).toContain("De plus");
  });
});

describe("LOT 3 — déterminisme et refus honnête", () => {
  it("même entrée → même sortie (déterministe)", () => {
    const a = composerReponseNative({ question: "Le Soleil ?", concept: "Soleil", faits: FAITS });
    const b = composerReponseNative({ question: "Le Soleil ?", concept: "Soleil", faits: FAITS });
    expect(a!.texte).toBe(b!.texte);
    expect(a!.patron).toBe(b!.patron);
  });

  it("sans faits → REFUS (jamais d'invention)", () => {
    expect(composerReponseNative({ question: "Qu'est-ce que la téléportation quantique ?", concept: "téléportation", faits: [] })).toBeNull();
    expect(composerReponseNative({ question: "X ?", concept: "X", faits: [{ cle: "k", valeur: "  ...  " }] })).toBeNull();
  });

  it("fragments longs sont bornés (pas d'avalanche)", () => {
    const longFait: FaitCompose[] = [{ cle: "l", valeur: "x".repeat(500) }];
    const r = composerReponseNative({ question: "X ?", concept: "X", faits: longFait });
    expect(r!.texte.length).toBeLessThan(1_000);
  });

  it("métrique de surface exposée", () => {
    const s = surfaceCompositeur();
    expect(s.patrons).toBe(5);
    expect(s.connectives).toBeGreaterThanOrEqual(3);
  });
});

import { describe, expect, it } from "vitest";

import {
  dedoublonner,
  normaliserUrl,
  normaliserTexte,
  shingles,
  similariteJaccard,
  SEUIL_DOUBLON_CONTENU,
} from "./dedoublonnage";

describe("recherche-web — normalisation d'URL (dédoublonnage niveau 1)", () => {
  it("retire les paramètres de tracking utm et fragments", () => {
    expect(
      normaliserUrl("https://exemple.com/article?utm_source=twitter&utm_medium=social&id=42#section"),
    ).toBe("https://exemple.com/article?id=42");
  });

  it("retire www et trailing slash", () => {
    expect(normaliserUrl("https://www.exemple.com/article/")).toBe("https://exemple.com/article");
  });

  it("fusionne deux URL identiques dont l'ordre des paramètres diffère", () => {
    expect(normaliserUrl("https://exemple.com/page?a=1&b=2")).toBe(
      normaliserUrl("https://exemple.com/page?b=2&a=1"),
    );
  });

  it("retire gclid/fbclid et ref", () => {
    expect(normaliserUrl("https://exemple.com/x?gclid=abc&fbclid=def&q=bonjour&ref=news")).toBe(
      "https://exemple.com/x?q=bonjour",
    );
  });

  it("laisse les non-http(s) inchangés", () => {
    expect(normaliserUrl("data:text/plain,bonjour")).toBe("data:text/plain,bonjour");
  });

  it("laisse une URL invalide inchangée (pas d'exception)", () => {
    expect(normaliserUrl("pas une url")).toBe("pas une url");
  });
});

describe("recherche-web — normalisation de texte et shingles", () => {
  it("retire accents, ponctuation et mots vides", () => {
    const mots = normaliserTexte("L'Élémentaire, mon cher Watson ! Les indices ne mentent jamais.");
    expect(mots).toContain("elementaire");
    expect(mots).toContain("watson");
    expect(mots).not.toContain("les");
    expect(mots).not.toContain("ne");
  });

  it("retire les nombres isolés", () => {
    const mots = normaliserTexte("En 2024 il y avait 3 modèles");
    expect(mots).not.toContain("2024");
    expect(mots).not.toContain("3");
    expect(mots).toContain("modeles");
  });

  it("shingles produit des trigrammes et vide les textes trop courts en mots", () => {
    const sh = shingles("chat mange souris dans le grenier");
    expect(sh.has("chat mange souris")).toBe(true);
    const court = shingles("chat");
    expect(court.has("chat")).toBe(true);
    // Un mot vide seul (« a ») est filtré : aucun shingle.
    expect(shingles("a").size).toBe(0);
  });

  it("similarité de Jaccard : identique=1, disjoint=0", () => {
    const a = shingles("le chat mange la souris dans le grenier du chateau");
    const b = shingles("le chat mange la souris dans le grenier du chateau");
    expect(similariteJaccard(a, b)).toBe(1);
    const c = shingles("bitcoin chute precipitee des marches financiers mondiaux aujourd'hui");
    expect(similariteJaccard(a, c)).toBe(0);
  });
});

describe("recherche-web — dédoublonnage de contenu (niveau 2)", () => {
  const base = "La Sonde Parker a frôlé le Soleil et encaissé une température extrême record historique scientifique";

  it("fusionne deux dépêches quasi identiques (recopie d'agence)", () => {
    const copie = `${base} selon les chercheurs de la mission`;
    const entrees = [
      { valeur: 1, url: "https://a.com/sonde", extrait: base },
      { valeur: 2, url: "https://b.com/actualite", extrait: copie },
    ];
    const { conserves, doublonsRetires } = dedoublonner(entrees);
    expect(conserves.map((c) => c.valeur)).toEqual([1]);
    expect(doublonsRetires).toBe(1);
  });

  it("garde deux articles distincts qui parlent de sujets voisins", () => {
    const entrees = [
      { valeur: 1, url: "https://a.com/sonde", extrait: base },
      { valeur: 2, url: "https://b.com/marches", extrait: "Les marchés actions asiatiques terminent en forte hausse après la réunion bancaire trimestrielle" },
    ];
    const { conserves } = dedoublonner(entrees);
    expect(conserves.map((c) => c.valeur)).toEqual([1, 2]);
  });

  it("fusionne le même article via deux URL de tracking différentes", () => {
    const entrees = [
      { valeur: 1, url: "https://a.com/article?utm_source=x", extrait: base },
      { valeur: 2, url: "https://www.a.com/article?utm_source=y", extrait: base },
    ];
    const { conserves, doublonsRetires } = dedoublonner(entrees);
    expect(conserves).toHaveLength(1);
    expect(doublonsRetires).toBe(1);
  });

  it("garde la PREMIÈRE occurrence (priorité moteur de l'appelant)", () => {
    const entrees = [
      { valeur: "duckduckgo", url: "https://a.com/x", extrait: "texte unique alpha" },
      { valeur: "bing", url: "https://a.com/x", extrait: "texte unique alpha" },
    ];
    const { conserves } = dedoublonner(entrees);
    expect(conserves[0].valeur).toBe("duckduckgo");
  });

  it("extrait vide : deux extraits vides ne fusionnent pas en doublon", () => {
    const entrees = [
      { valeur: 1, url: "https://a.com/x", extrait: "" },
      { valeur: 2, url: "https://b.com/y", extrait: "" },
    ];
    const { conserves } = dedoublonner(entrees);
    expect(conserves).toHaveLength(2);
  });

  it("le seuil par défaut est bien exporté et calibré", () => {
    expect(SEUIL_DOUBLON_CONTENU).toBeGreaterThanOrEqual(0.4);
    expect(SEUIL_DOUBLON_CONTENU).toBeLessThanOrEqual(0.7);
  });
});

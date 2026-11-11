import { describe, expect, it } from "vitest";

import { credibiliteDomaine, validerDatePublication } from "./verification-sources";

describe("recherche-web — validation des dates de publication", () => {
  it("accepte une ISO valide passée", () => {
    const validee = validerDatePublication("2026-10-20T12:00:00Z");
    expect(validee).toBeDefined();
    expect(validee).toMatch(/^2026-10-20/);
  });

  it("accepte un format RSS français courant", () => {
    expect(validerDatePublication("20 Oct 2026 10:00:00 GMT")).toBeDefined();
    expect(validerDatePublication("Tue, 20 Oct 2026 10:00:00 GMT")).toBeDefined();
  });

  it("refuse une date du futur", () => {
    const futur = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect(validerDatePublication(futur)).toBeUndefined();
  });

  it("tolère un décalage de fuseau ≤ 24 h", () => {
    const presque = new Date(Date.now() + 10 * 3600_000).toISOString();
    expect(validerDatePublication(presque)).toBeDefined();
  });

  it("refuse une date antérieure à 1995 (erreur de parse)", () => {
    expect(validerDatePublication("1970-01-01T00:00:00Z")).toBeUndefined();
  });

  it("refuse les formats non parsables et les vides", () => {
    expect(validerDatePublication("demain matin")).toBeUndefined();
    expect(validerDatePublication("")).toBeUndefined();
    expect(validerDatePublication(undefined)).toBeUndefined();
  });
});

describe("recherche-web — crédibilité des domaines", () => {
  it("classe élevée : encyclopédie, institutions, revues", () => {
    expect(credibiliteDomaine("https://fr.wikipedia.org/wiki/IA")).toBe("elevée");
    expect(credibiliteDomaine("https://www.who.int/news")).toBe("elevée");
    expect(credibiliteDomaine("https://arxiv.org/abs/2401.12345")).toBe("elevée");
  });

  it("classe moyenne : presse et tech établies", () => {
    expect(credibiliteDomaine("https://www.lemonde.fr/economie/")).toBe("moyenne");
    expect(credibiliteDomaine("https://www.bbc.com/news")).toBe("moyenne");
    expect(credibiliteDomaine("https://developer.mozilla.org/fr/")).toBe("moyenne");
  });

  it("gère www et sous-domaines", () => {
    expect(credibiliteDomaine("https://en.wikipedia.org/wiki/X")).toBe("elevée");
    expect(credibiliteDomaine("https://www.reuters.com/article")).toBe("moyenne");
  });

  it("classe inconnue : domaine inconnu, URL invalide", () => {
    expect(credibiliteDomaine("https://blog-totalement-inconnu.example")).toBe("inconnue");
    expect(credibiliteDomaine("pas-une-url")).toBe("inconnue");
  });

  it("ne cense pas : tout est classé, jamais undefined", () => {
    expect(credibiliteDomaine("https://exemple-inconnu.xyz/a")).toBe("inconnue");
  });
});

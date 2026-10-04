import { describe, expect, it } from "vitest";

import { extractVideoTitle, looksLikeVideoRequest } from "./video-intent";

describe("looksLikeVideoRequest", () => {
  it("détecte les demandes FR de production vidéo", () => {
    expect(looksLikeVideoRequest("Génère une vidéo de présentation de Lyon")).toBe(true);
    expect(looksLikeVideoRequest("crée une vidéo publicitaire pour ma boulangerie")).toBe(true);
    expect(looksLikeVideoRequest("fais-moi un clip de 30 secondes sur le fitness")).toBe(true);
    expect(looksLikeVideoRequest("monte un short vertical avec des sous-titres")).toBe(true);
    expect(looksLikeVideoRequest("je veux un reel instagram sur les recettes véganes")).toBe(true);
  });

  it("détecte les demandes EN", () => {
    expect(looksLikeVideoRequest("create a video about space exploration")).toBe(true);
    expect(looksLikeVideoRequest("generate a 60s teaser for my app")).toBe(true);
  });

  it("ne déclenche PAS sur les questions méta", () => {
    expect(looksLikeVideoRequest("c'est quoi un bon montage vidéo ?")).toBe(false);
    expect(looksLikeVideoRequest("comment créer une vidéo professionnelle ?")).toBe(false);
    expect(looksLikeVideoRequest("quel logiciel de montage video choisir ?")).toBe(false);
    expect(looksLikeVideoRequest("quelle est la différence entre un clip et un reel ?")).toBe(false);
  });

  it("ne déclenche PAS sur les pages/sites web (routage artefact application)", () => {
    expect(looksLikeVideoRequest("crée une page web avec une vidéo de présentation")).toBe(false);
    expect(looksLikeVideoRequest("fais un site vitrine avec un clip d'accueil")).toBe(false);
  });

  it("ne déclenche PAS sur du texte sans verbe de création ni nom de vidéo", () => {
    expect(looksLikeVideoRequest("Le film Blade Runner est culte")).toBe(false);
    expect(looksLikeVideoRequest("bonjour")).toBe(false);
    expect(looksLikeVideoRequest("")).toBe(false);
  });
});

describe("extractVideoTitle", () => {
  it("nettoie les formules d'adresse et les articles", () => {
    expect(extractVideoTitle("Génère-moi une vidéo de présentation de Lyon")).toBe("présentation de Lyon");
    expect(extractVideoTitle("Crée une vidéo publicitaire pour ma boulangerie")).toBe("publicitaire pour ma boulangerie");
  });

  it("tronque à 80 caractères et ne rend jamais vide", () => {
    expect(extractVideoTitle("vidéo")).toBe("vidéo");
    const long = extractVideoTitle(`Génère une vidéo sur ${"x".repeat(200)}`);
    expect(long.length).toBeLessThanOrEqual(80);
  });
});

import { describe, expect, it } from "vitest";

import {
  composerDepuisRechercheWeb,
  composerRepliHonnete,
  savoirInsuffisant,
} from "./recherche-web-pont";

/**
 * PONT RECHERCHE WEB — la garantie « jamais sans réponse ». Tests purs :
 * juge de suffisance du savoir, composition fondée sur les sources (citées,
 * filtrées par pertinence) et repli honnête TOUJOURS non vide.
 */

describe("savoirInsuffisant — le juge honnête du filet", () => {
  it("juge insuffisant : composition vide, texte court ou repli du décodeur", () => {
    expect(savoirInsuffisant(null)).toBe(true);
    expect(savoirInsuffisant({ texte: "   ", source: "decoder_intention" })).toBe(true);
    expect(
      savoirInsuffisant({ texte: "réponse courte", source: "decoder_intention" }),
    ).toBe(true);
    // Le repli du décodeur = aucune matière interne (même sur un texte long).
    expect(
      savoirInsuffisant({
        texte: "Voici un texte décodé du réseau qui reste pourtant générique et sans appariement réel.",
        source: "decoder_intention",
      }),
    ).toBe(true);
  });

  it("juge insuffisant : appariement cortex trop faible (risque de hors-sujet)", () => {
    expect(
      savoirInsuffisant({
        texte: "Une réponse du cortex assez longue pour passer le seuil de longueur sans problème.",
        source: "cortex_corpus",
        scoreAppariement: 0.1,
      }),
    ).toBe(true);
  });

  it("juge suffisant : pilotage, connaissances ou paire cortex bien appariée", () => {
    const longue =
      "Voici la réponse complète à votre demande, avec assez de matière pour être utile directement : elle couvre le contexte, la méthode et les étapes à suivre, puis les points d'attention et les critères de réussite mesurables que vous attendez.";
    expect(
      savoirInsuffisant({ texte: longue, source: "pilotage" }),
    ).toBe(false);
    expect(
      savoirInsuffisant({ texte: longue, source: "connaissances_utilisateur" }),
    ).toBe(false);
    expect(
      savoirInsuffisant({
        texte: longue,
        source: "cortex_corpus",
        scoreAppariement: 0.8,
      }),
    ).toBe(false);
  });
});

describe("composerDepuisRechercheWeb — réponse fondée sur les sources", () => {
  const resultats = [
    { titre: "Guide officiel du protocole X", url: "https://example.org/x", extrait: "Le protocole X définit l'échange de messages et la couche transport." },
    { titre: "Recette de cuisine", url: "https://example.org/cuisine", extrait: "Préchauffer le four à 180 degrés." },
  ];

  it("compose une réponse avec citations, URLs et mention honnête de la recherche", () => {
    const composition = composerDepuisRechercheWeb(
      "Comment fonctionne le protocole X ?",
      resultats,
    );
    expect(composition).not.toBeNull();
    expect(composition?.source).toBe("recherche_web");
    expect(composition?.texte).toContain("recherche web");
    expect(composition?.texte).toContain("https://example.org/x");
    expect(composition?.texte).toContain("protocole X");
    // La source non pertinente (recette) est écartée par le recouvrement lexical.
    expect(composition?.texte).not.toContain("example.org/cuisine");
  });

  it("renvoie null sans résultat pertinent (l'appelant passera au repli honnête)", () => {
    expect(composerDepuisRechercheWeb("théorie quantique des cordes", [resultats[1]])).toBeNull();
    expect(composerDepuisRechercheWeb("", resultats)).toBeNull();
    expect(composerDepuisRechercheWeb("protocole X", [])).toBeNull();
  });
});

describe("composerRepliHonnete — la dernière ligne de défense (jamais vide)", () => {
  it("répond toujours : état honnête + voies concrètes pour l'utilisateur", () => {
    const composition = composerRepliHonnete("Qubit topologique en 2049 ?", null);
    expect(composition.source).toBe("repli_honnete");
    expect(composition.texte.length).toBeGreaterThan(200);
    expect(composition.texte).toContain("Qubit topologique en 2049");
    expect(composition.texte).toContain("Recherche web");
    expect(composition.texte).toContain("reformulez");
  });

  it("restitue une matière subsistante quand quelque chose d'utile existe", () => {
    const composition = composerRepliHonnete("ma demande", {
      texte: "Un contenu subsistant suffisamment long pour être jugé utile à l'utilisateur final : il reprend le contexte de la demande, ce qui est connu du sujet, et la limite exacte de ce que le moteur peut affirmer sans inventer.",
      source: "decoder_intention",
    });
    expect(composition.texte).toContain("Un contenu subsistant");
  });
});

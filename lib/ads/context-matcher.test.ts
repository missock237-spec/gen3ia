import { describe, expect, it } from "vitest";

import {
  CONTEXTUAL_MIN_SCORE,
  extractContextTokens,
  lightStem,
  normalizeText,
  pickContextualAd,
  rankAdsByRelevance,
  scoreAdRelevance,
  stableHash,
  tokenize,
  type ContextualAdLike,
} from "./context-matcher";

/**
 * CIBLAGE CONTEXTUEL GEN ADS — la publicité affichée ne doit JAMAIS être
 * choisie au hasard : elle doit présenter une similitude sémantique avec la
 * requête de l'utilisateur (demande explicite du porteur du projet).
 *
 * Couverture :
 *  - normalisation (accents, casse, ponctuation) et mots vides FR/EN ;
 *  - racinisation légère (banques→banque→banqu, formations→form) ;
 *  - familles de synonymes (voiture ↔ automobile, recette ↔ cuisine) ;
 *  - scoring : mots-clés déclarés > recouvrement du texte publicitaire ;
 *  - sélection : seuil de pertinence, RÉSULTAT STRICT (rien si aucune
 *    similitude), déterminisme des ex æquo.
 */

function ad(overrides: Partial<ContextualAdLike> & { id: string }): ContextualAdLike {
  // Titre/annonceur NEUTRES : aucun mot d'une famille de synonymes — les
  // tests de mots-clés ne doivent mesurer QUE le signal déclaré.
  return {
    title: "Enseigne partenaire",
    advertiser: "Distributeur",
    ...overrides,
  };
}

describe("normalizeText — normalisation FR/EN", () => {
  it("retire les accents, la casse et la ponctuation", () => {
    expect(normalizeText("Café-Resto À Gônder")).toBe("cafe resto a gonder");
    expect(normalizeText("L'État, c'est MOI !")).toBe("l etat c est moi");
    expect(normalizeText("Éducation & Formation...")).toBe("education formation");
  });

  it("gère les entrées vides et non textuelles sans lever", () => {
    expect(normalizeText("")).toBe("");
    expect(normalizeText("   ")).toBe("");
    expect(normalizeText(undefined as unknown as string)).toBe("");
  });
});

describe("tokenize — mots vides FR/EN exclus", () => {
  it("supprime les mots vides français et anglais", () => {
    expect(tokenize("je veux une recette de cuisine pour le dîner"))
      .toEqual(["recette", "cuisine", "diner"]);
    expect(tokenize("I want a recipe for dinner tonight"))
      .toEqual(["recipe", "dinner", "tonight"]);
  });

  it("écarte les tokens trop courts", () => {
    expect(tokenize("un a je il y")).toEqual([]);
  });
});

describe("lightStem — racinisation symétrique FR/EN", () => {
  it("converge les pluriels et dérivations françaises", () => {
    expect(lightStem("banques")).toBe(lightStem("banque"));
    expect(lightStem("formations")).toBe(lightStem("formation"));
    expect(lightStem("voitures")).toBe(lightStem("voiture"));
    expect(lightStem("restaurants")).toBe(lightStem("restaurant"));
    expect(lightStem("immobiliere")).toBe(lightStem("immobilier"));
  });

  it("converge les pluriels irréguliers en -al/-aux", () => {
    expect(lightStem("journaux")).toBe(lightStem("journal"));
  });

  it("ne rabote pas en dessous de la longueur minimale (prix, page intacts)", () => {
    expect(lightStem("prix")).toBe("prix");
    expect(lightStem("eau")).toBe("eau");
    expect(lightStem("page")).toBe("page");
  });
});

describe("scoreAdRelevance — signaux de ressemblance", () => {
  it("score un mot-clé déclaré exact plus fort qu'une ressemblance", () => {
    const context = extractContextTokens("je cherche une recette de cuisine");
    const exact = scoreAdRelevance(ad({ id: "a", keywords: ["recette"] }), context);
    const synonym = scoreAdRelevance(ad({ id: "b", keywords: ["gastronomie"] }), context);
    expect(exact).toBeGreaterThanOrEqual(3);
    expect(synonym).toBeGreaterThan(0);
    expect(exact).toBeGreaterThan(synonym);
  });

  it("reconnaît une similitude par famille de synonymes (voiture ↔ automobile)", () => {
    const context = extractContextTokens("je veux acheter une automobile familiale");
    const score = scoreAdRelevance(ad({ id: "a", keywords: ["voiture"] }), context);
    expect(score).toBeGreaterThanOrEqual(CONTEXTUAL_MIN_SCORE);
  });

  it("reconnaît une similitude par racine (cuisiner ↔ cuisine)", () => {
    const context = extractContextTokens("comment cuisiner des légumes du jardin");
    const score = scoreAdRelevance(ad({ id: "a", keywords: ["cuisine"] }), context);
    expect(score).toBeGreaterThanOrEqual(CONTEXTUAL_MIN_SCORE);
  });

  it("reconnaît une ressemblance par le texte de la créa sans mots-clés", () => {
    const context = extractContextTokens("propose-moi un cours de photographie");
    const withTitle = scoreAdRelevance(
      ad({ id: "a", title: "Formation photographie et retouche" }),
      context,
    );
    const unrelated = scoreAdRelevance(
      ad({ id: "b", title: "Assurance auto pas chère" }),
      context,
    );
    expect(withTitle).toBeGreaterThan(unrelated);
    expect(unrelated).toBe(0);
  });

  it("un mot-clé multi-mots ne matche que si TOUS ses mots correspondent", () => {
    const context = extractContextTokens("marketing digital pour ma startup");
    expect(scoreAdRelevance(ad({ id: "a", keywords: ["marketing digital"] }), context)).toBeGreaterThan(0);
    expect(scoreAdRelevance(ad({ id: "b", keywords: ["marketing immobilier"] }), context)).toBe(0);
  });

  it("ignore une sous-chaîne trop courte (bruit)", () => {
    const context = extractContextTokens("radiateur de voiture");
    // « ia » (2 lettres) ne doit pas matcher « radiateur » par sous-chaîne.
    expect(scoreAdRelevance(ad({ id: "a", keywords: ["ia"] }), context)).toBe(0);
  });
});

describe("rankAdsByRelevance — seuil et tri", () => {
  const pool: ContextualAdLike[] = [
    ad({ id: "cuisine-1", title: "Masterclass cuisine", keywords: ["recette", "chef"] }),
    ad({ id: "auto-1", title: "Garage auto Express", keywords: ["voiture", "pneu"] }),
    ad({ id: "voyage-1", title: "Voyages pas chers", keywords: ["hotel", "plage"] }),
  ];

  it("ne classe QUE les annonces similaires à la requête, meilleures d'abord", () => {
    const ranked = rankAdsByRelevance(pool, "une recette de cuisine pour ce soir");
    expect(ranked.map((entry) => entry.ad.id)).toEqual(["cuisine-1"]);
    expect(ranked[0].score).toBeGreaterThanOrEqual(CONTEXTUAL_MIN_SCORE);
  });

  it("classe plusieurs annonces similaires par score décroissant", () => {
    const ranked = rankAdsByRelevance(pool, "je cherche un garage pour ma voiture et une recette de cuisine");
    expect(ranked.length).toBe(2);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
    expect(new Set(ranked.map((entry) => entry.ad.id))).toEqual(new Set(["cuisine-1", "auto-1"]));
  });

  it("contexte vide → AUCUNE annonce classée (pas de repli aléatoire)", () => {
    expect(rankAdsByRelevance(pool, "")).toEqual([]);
    expect(rankAdsByRelevance(pool, "   ")).toEqual([]);
    expect(rankAdsByRelevance(pool, "le la les de du a")).toEqual([]);
  });

  it("requête sans rapport → AUCUNE annonce classée (STRICT)", () => {
    expect(rankAdsByRelevance(pool, "traduis ce poème en latin")).toEqual([]);
  });
});

describe("pickContextualAd — sélection déterministe", () => {
  const pool: ContextualAdLike[] = [
    ad({ id: "a", title: "Cours de cuisine", keywords: ["cuisine"] }),
    ad({ id: "b", title: "Ustensiles de cuisine", keywords: ["cuisine", "chef"] }),
    ad({ id: "c", title: "Crédit immobilier", keywords: ["maison"] }),
  ];

  it("retourne l'annonce la plus similaire à la requête", () => {
    expect(pickContextualAd(pool, "apprendre la cuisine", "msg:1")?.id).toBe("b");
  });

  it("retourne null quand AUCUNE annonce ne présente de similitude", () => {
    expect(pickContextualAd(pool, "répare ma connexion internet", "msg:1")).toBeNull();
  });

  it("est stable : la même clé ne change JAMAIS d'annonce (re-render)", () => {
    const first = pickContextualAd(pool, "cuisine, recettes", "msg:42");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(pickContextualAd(pool, "cuisine, recettes", "msg:42")?.id).toBe(first?.id);
    }
  });

  it("départage les ex æquo par hachage de la clé (variété déterministe)", () => {
    // Deux annonces strictement équivalentes face à la requête.
    const ties: ContextualAdLike[] = [
      ad({ id: "x", title: "Cuisine", keywords: ["cuisine"] }),
      ad({ id: "y", title: "Cuisine", keywords: ["cuisine"] }),
    ];
    const chosen = new Set<string>();
    for (let index = 0; index < 12; index += 1) {
      const picked = pickContextualAd(ties, "recette de cuisine", `msg:${index}`);
      expect(picked).not.toBeNull();
      chosen.add(picked!.id);
    }
    // Plusieurs clés → les deux ex æquo sont servis (pas de favori figé).
    expect(chosen.size).toBe(2);
  });
});

describe("stableHash — déterminisme", () => {
  it("produit un hachage déterministe sur 32 bits", () => {
    expect(stableHash("msg:1")).toBe(stableHash("msg:1"));
    expect(stableHash("msg:1")).not.toBe(stableHash("msg:2"));
    expect(Number.isInteger(stableHash("clé"))).toBe(true);
  });
});

describe("exigence métier — « jamais d'affichage aléatoire »", () => {
  it("une même requête sur le même pool produit TOUJOURS la même annonce", () => {
    const pool: ContextualAdLike[] = [
      ad({ id: "tech", title: "Agence web", keywords: ["site", "seo"] }),
      ad({ id: "food", title: "Traiteur Gourmet", keywords: ["repas", "chef"] }),
      ad({ id: "edu", title: "Cours particuliers", keywords: ["lecon", "examen"] }),
    ];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(pickContextualAd(pool, "crée-moi un site vitrine avec du SEO", "msg:7")?.id).toBe("tech");
    }
  });

  it("des requêtes DIFFÉRENTES sélectionnent des annonces cohérentes avec leur sujet", () => {
    const pool: ContextualAdLike[] = [
      ad({ id: "tech", title: "Agence web", keywords: ["site", "seo"] }),
      ad({ id: "food", title: "Traiteur Gourmet", keywords: ["repas", "chef", "cuisine"] }),
      ad({ id: "edu", title: "Cours particuliers", keywords: ["lecon", "examen", "formation"] }),
    ];
    expect(pickContextualAd(pool, "optimise le référencement de mon site", "m1")?.id).toBe("tech");
    expect(pickContextualAd(pool, "prépare un menu pour un repas de fête", "m2")?.id).toBe("food");
    expect(pickContextualAd(pool, "je veux une formation en ligne", "m3")?.id).toBe("edu");
  });
});

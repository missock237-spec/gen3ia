/**
 * TESTS DU LOT 2 — compréhension sémantique générale (mission
 * « GEN3IA BRAIN COMPLETION »). Chaque test mesure un comportement réel du
 * module sémantique : relations du lexique, négation, questions, similarité
 * enrichie (paraphrases que le lexical pur rate), bornes et symétrie.
 */

import { describe, expect, it } from "vitest";

import {
  analyserSemantique,
  comparerSemantique,
  similariteSemantique,
  surfaceSemantique,
} from "./analyseur-semantique";
import { GROUPES_SYNONYMES, PAIRES_ANTONYMES, PAIRES_HYPERONYMES, PAIRES_MERONYMES, tailleLexique } from "./lexique-relations";

describe("LOT 2 — lexique de relations sémantiques", () => {
  it("taille honnête et cohérente des quatre familles de relations", () => {
    const t = tailleLexique();
    expect(t.synonymes).toBe(GROUPES_SYNONYMES.length);
    expect(t.synonymes).toBeGreaterThanOrEqual(70);
    expect(t.antonymes).toBeGreaterThanOrEqual(30);
    expect(t.hyperonymes).toBeGreaterThanOrEqual(40);
    expect(t.meronymes).toBeGreaterThanOrEqual(25);
  });

  it("les données ne contiennent pas d'entrée vide ou dupliquée dans un groupe", () => {
    for (const groupe of GROUPES_SYNONYMES) {
      expect(groupe.length).toBeGreaterThanOrEqual(2);
      expect(new Set(groupe).size).toBe(groupe.length);
    }
    for (const [a, b] of PAIRES_ANTONYMES) expect(a).not.toBe(b);
    for (const [inst, cat] of PAIRES_HYPERONYMES) expect(inst).not.toBe(cat);
    for (const [partie, tout] of PAIRES_MERONYMES) expect(partie).not.toBe(tout);
  });
});

describe("LOT 2 — analyseur (négation, questions, concepts)", () => {
  it("détecte la négation sous toutes ses formes", () => {
    expect(analyserSemantique("Le chat dort").negation).toBe(false);
    expect(analyserSemantique("Le chat ne dort pas").negation).toBe(true);
    expect(analyserSemantique("Il n'y a aucun problème").negation).toBe(true);
    expect(analyserSemantique("Je n'ai jamais vu cela").negation).toBe(true);
    expect(analyserSemantique("Sans exception, tout est prêt").negation).toBe(true);
  });

  it("type les questions françaises", () => {
    expect(analyserSemantique("Pourquoi le ciel est bleu ?").question).toBe("pourquoi");
    expect(analyserSemantique("Comment installer Node.js ?").question).toBe("comment");
    expect(analyserSemantique("Qu'est-ce que la photosynthèse ?").question).toBe("defini");
    expect(analyserSemantique("Qui a inventé le téléphone ?").question).toBe("qui");
    expect(analyserSemantique("Combien de pays en Europe ?").question).toBe("combien");
    expect(analyserSemantique("Le chat dort profondément.").question).toBe("aucune");
  });

  it("extrait les concepts avec leurs relations (catégories, parties)", () => {
    const a = analyserSemantique("Le chat dort sur le canapé");
    const chat = a.concepts.find((c) => c.racine.startsWith("chat"));
    expect(chat).toBeDefined();
    expect(chat!.categories).toContain("animal"); // hyperonymie du lexique

    const b = analyserSemantique("Une roue du moteur");
    const roue = b.concepts.find((c) => c.racine.startsWith("rou"));
    expect(roue?.parties).toContain("voiture"); // méronymie (racine complète)
  });

  it("étend les racines par groupes de synonymes partagés", () => {
    const a = analyserSemantique("acheter une voiture");
    expect(a.racinesEtendues.filter((r) => r.startsWith("groupe:")).length).toBeGreaterThan(0);
  });
});

describe("LOT 2 — similarité sémantique (au-delà du lexical)", () => {
  it("paraphrases : le sémantique corrige l'angle mort du lexical pur", () => {
    const a = "acheter une voiture";
    const b = "acquérir un véhicule";
    const c = comparerSemantique(a, b);
    // Les mots diffèrent (lexical faible) mais les groupes de synonymes
    // (acheter/acquérir + voiture/véhicule) comblent l'écart.
    expect(c.lexical).toBeLessThan(0.5);
    expect(c.score).toBeGreaterThan(0.45);
    expect(c.groupesSynonymesPartages).toBeGreaterThanOrEqual(1);
  });

  it("les liens catégoriels relient instance et catégorie", () => {
    const score = similariteSemantique("un chien aboie dans le jardin", "un animal domestique joue");
    expect(score).toBeGreaterThan(0.25); // chien→animal (hyperonymie)
  });

  it("la négation oppose deux phrases lexicalement identiques", () => {
    const c = comparerSemantique("Le chat dort profondément", "Le chat ne dort pas profondément");
    expect(c.negationOpposee).toBe(true);
    expect(c.score).toBeLessThanOrEqual(0.3); // pénalité honnête
  });

  it("borne [0,1] + symétrie + identité", () => {
    const paires = [
      ["la terre est ronde", "la planète bleue"],
      ["je code en python", "le python sert à coder"],
      ["tout va bien", "rien ne va"],
    ];
    for (const [a, b] of paires) {
      const ab = similariteSemantique(a, b);
      const ba = similariteSemantique(b, a);
      expect(ab).toBeGreaterThanOrEqual(0);
      expect(ab).toBeLessThanOrEqual(1);
      expect(ab).toBe(ba); // symétrie
    }
    expect(similariteSemantique("la photosynthèse des plantes", "la photosynthèse des plantes")).toBeGreaterThanOrEqual(0.95);
    expect(similariteSemantique("", "quelque chose")).toBe(0);
  });

  it("les phrases sans aucun mot du lexique restent traitables (dégradé honnête)", () => {
    const c = comparerSemantique("xyzzy plugh qwerty", "foo bar baz");
    expect(c.score).toBeLessThanOrEqual(0.1);
    expect(Number.isFinite(c.score)).toBe(true);
  });
});

describe("LOT 2 — surface du module (métrique laboratoire)", () => {
  it("expose la taille du lexique, les marqueurs de négation et de question", () => {
    const s = surfaceSemantique();
    expect(s.lexique.synonymes).toBeGreaterThan(0);
    expect(s.negations).toBeGreaterThanOrEqual(6);
    expect(s.questions).toBeGreaterThanOrEqual(8);
  });
});

import { describe, expect, it } from "vitest";

import {
  construireRequetesRecherche,
  directifReflexionProfonde,
  estTacheRecherchable,
  evalueDifficulte,
  MAX_PAGES_RECHERCHE,
  MIN_PAGES_RECHERCHE,
  sectionReflexionEtRecherche,
} from "./raisonnement-profond";

/**
 * RÉFLEXION PROFONDE + RECHERCHE WEB SYSTÉMATIQUE (demande produit
 * 2026-11-22) — contrats verrouillés :
 *  1. plancher ABSOLU de 10 pages réellement lues pour TOUTE tâche ;
 *  2. le nombre de pages croît avec la difficulté (prompt long/complexe
 *     ⇒ davantage de pages) ;
 *  3. les requêtes de recherche sont différenciées selon le niveau ;
 *  4. la directive de réflexion expose les 4 phases (compréhension,
 *     multi-angles, vérification, synthèse) ;
 *  5. estTacheRecherchable : salutation → NON, tâche → OUI, compatible
 *     avec le contrat tool-intent (« Bonjour » → aucun indice ;
 *     remplissage sans verbe d'action → aucun indice).
 */
describe("evalueDifficulte", () => {
  it("garantit le plancher de 10 pages pour TOUTE demande", () => {
    const echantillons = [
      "",
      "Bonjour",
      "crée un logo",
      "aide-moi à améliorer mes ventes",
      `${"analyse très détaillée du marché et compare les concurrents, ensuite prépare un rapport complet ".repeat(20)}? ??`,
    ];
    for (const echantillon of echantillons) {
      const evaluation = evalueDifficulte(echantillon);
      expect(evaluation.pagesRequises).toBeGreaterThanOrEqual(MIN_PAGES_RECHERCHE);
      expect(evaluation.pagesRequises).toBeLessThanOrEqual(MAX_PAGES_RECHERCHE);
    }
  });

  it("gradue les pages selon la difficulté (prompt long et complexe ⇒ plus de pages)", () => {
    const simple = evalueDifficulte("crée un logo pour ma boulangerie");
    const complexe = evalueDifficulte(
      [
        "Analyse complète du marché des cafés spécialisés et compare les concurrents,",
        "ensuite prépare un rapport PDF avec une stratégie de bout en bout :",
        "- étude de la réglementation",
        "- évaluation financière et diagnostic",
        "- plan de déploiement de l'application",
        "Comment nous positionner ? Quels risques ? Quelle architecture ?",
      ].join(" "),
    );
    expect(complexe.score).toBeGreaterThan(simple.score);
    expect(complexe.pagesRequises).toBeGreaterThan(simple.pagesRequises);
    expect(["complexe", "extreme"]).toContain(complexe.niveau);
  });

  it("restreint au plafond MAX_PAGES_RECHERCHE même pour un prompt géant", () => {
    const evaluation = evalueDifficulte(
      `${"workflow api analyse stratégie étape compare audit rapport résoudre un problème complexe de déploiement ".repeat(300)}`.slice(0, 2000),
    );
    expect(evaluation.pagesRequises).toBeLessThanOrEqual(MAX_PAGES_RECHERCHE);
    expect(evaluation.niveau).toBe("extreme");
  });
});

describe("construireRequetesRecherche", () => {
  it("construit toujours le cœur de la demande en première requête", () => {
    const evaluation = evalueDifficulte("crée un site e-commerce pour vendre du café");
    const requetes = construireRequetesRecherche("crée un site e-commerce pour vendre du café", evaluation);
    expect(requetes.length).toBeGreaterThanOrEqual(2);
    expect(requetes[0]).toContain("site e-commerce");
  });

  it("différencie les angles selon le niveau (extreme ⇒ 5 requêtes)", () => {
    const evaluation = evalueDifficulte("analyse stratégique complète: ".padEnd(120, "comparaison audit étape workflow api ?"));
    const requetes = construireRequetesRecherche("analyse stratégique du marché du café", evaluation);
    if (evaluation.niveau === "extreme") {
      expect(requetes).toHaveLength(5);
    } else {
      expect(requetes.length).toBeGreaterThanOrEqual(2);
    }
    // Angles différenciés : pas de doublon exact.
    expect(new Set(requetes).size).toBe(requetes.length);
  });

  it("retire les URLs du cœur (jamais de requête polluée)", () => {
    const evaluation = evalueDifficulte("résume cette page");
    const requetes = construireRequetesRecherche("résume cette page https://exemple.com/article?a=1 merci", evaluation);
    expect(requetes.every((requete) => !requete.includes("https://"))).toBe(true);
  });
});

describe("directifReflexionProfonde", () => {
  it("expose les 4 phases pour les niveaux élevés", () => {
    const directive = directifReflexionProfonde("complexe");
    expect(directive).toContain("PHASE 1");
    expect(directive).toContain("COMPRÉHENSION");
    expect(directive).toContain("PHASE 2");
    expect(directive).toContain("MULTI-ANGLES");
    expect(directive).toContain("PHASE 3");
    expect(directive).toContain("VÉRIFICATION");
    expect(directive).toContain("PHASE 4");
    expect(directive).toContain("SYNTHÈSE");
  });

  it("reste compact pour les demandes simples (version courte sans phases)", () => {
    const simple = directifReflexionProfonde("simple");
    const extreme = directifReflexionProfonde("extreme");
    expect(simple).not.toContain("PHASE 1");
    expect(extreme.length).toBeGreaterThan(simple.length);
    expect(extreme).toContain("MODE ÉTENDU");
  });
});

describe("estTacheRecherchable", () => {
  it("rejette les salutations et les messages trop courts", () => {
    expect(estTacheRecherchable("Bonjour")).toBe(false);
    expect(estTacheRecherchable("salut !")).toBe(false);
    expect(estTacheRecherchable("")).toBe(false);
    expect(estTacheRecherchable("merci beaucoup pour ton aide")).toBe(false);
  });

  it("accepte toute tâche avec verbe d'action substantielle", () => {
    expect(estTacheRecherchable("crée-moi un site e-commerce complet avec paiement en ligne")).toBe(true);
    expect(estTacheRecherchable("analyse les ventes du dernier trimestre et prépare un rapport")).toBe(true);
    expect(estTacheRecherchable("aide-moi à résoudre ce problème de build qui échoue depuis hier")).toBe(true);
  });

  it("accepte les questions substantielles (≥ 60 caractères)", () => {
    expect(estTacheRecherchable("comment améliorer durablement la fidélisation des clients d'une boulangerie artisanale en zone urbaine ?")).toBe(true);
    expect(estTacheRecherchable("c'est quoi un logo ?")).toBe(false);
  });

  it("reste compatible avec le contrat tool-intent (remplissage sans verbe d'action)", () => {
    const long = "remplissage ".repeat(400);
    expect(estTacheRecherchable(long)).toBe(false);
  });

  it("est ReDoS-safe (temps quasi-linéaire)", () => {
    const pathologiques = [
      "a".repeat(100_000),
      "((((((((((a".repeat(5_000),
      "@@@@@@@@@@".repeat(5_000),
    ];
    const debut = performance.now();
    for (const echantillon of pathologiques) expect(estTacheRecherchable(echantillon)).toBe(false);
    expect(performance.now() - debut).toBeLessThan(2_000);
  });
});

describe("sectionReflexionEtRecherche", () => {
  it("combine directive de réflexion + exigence de recherche multi-pages", () => {
    const section = sectionReflexionEtRecherche("prépare un rapport d'analyse complet du marché des véhicules électriques et compare les concurrents");
    expect(section).toContain("RÉFLEXION PROFONDE");
    expect(section).toContain("RECHERCHE WEB SYSTÉMATIQUE");
    expect(section).toContain("web.deep_research");
    // Le plancher de 10 pages est toujours énoncé.
    expect(section).toMatch(/au MINIMUM \d+ pages/);
    const pagesMatch = section.match(/au MINIMUM (\d+) pages/);
    expect(Number(pagesMatch?.[1] ?? 0)).toBeGreaterThanOrEqual(10);
  });
});

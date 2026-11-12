import { describe, expect, it } from "vitest";

import { outilDevRegex } from "./regex";

/**
 * Tests de l'outil `dev.regex` — testeur d'expressions régulières avec
 * garde ReDoS. Aucune exécution réellement pathologique : les tests de
 * sécurité portent sur les bornes d'entrée, l'avis heuristique, le
 * découpage en fenêtres (déduplication aux frontières) et l'échéance
 * (deadlineMs = 0 → échéance déjà échue, comportement déterministe).
 */

const CONTEXTE = { userId: "utilisateur-test", executionId: "exec-test" };

function entree(remplace: Record<string, unknown> = {}) {
  return outilDevRegex.inputSchema.parse({ pattern: "a", chaines: ["aaa"], ...remplace });
}

describe("dev.regex — correspondances et groupes", () => {
  it("renvoie les correspondances avec index et valeur", async () => {
    const resultat = await outilDevRegex.execute(entree({ pattern: "a+", chaines: ["xaaay"] }), CONTEXTE);
    expect(resultat.succes).toBe(true);
    expect(resultat.resultats[0]?.correspondances).toEqual([
      { valeur: "aaa", index: 1, groupes: [] },
    ]);
    expect(resultat.resultats[0]?.nombre).toBe(1);
    expect(resultat.totalCorrespondances).toBe(1);
  });

  it("expose les groupes de capture (y compris null)", async () => {
    const resultat = await outilDevRegex.execute(
      entree({ pattern: "(\\d{4})-(\\d{2})(?:-(\\d{2}))?", chaines: ["2025-06", "2026-01-15"] }),
      CONTEXTE,
    );
    expect(resultat.resultats[0]?.correspondances[0]?.groupes).toEqual(["2025", "06", null]);
    expect(resultat.resultats[1]?.correspondances[0]?.groupes).toEqual(["2026", "01", "15"]);
  });

  it("expose les groupes nommés", async () => {
    const resultat = await outilDevRegex.execute(
      entree({ pattern: "(?<jour>\\d{2})/(?<mois>\\d{2})", chaines: ["expiré le 05/12"] }),
      CONTEXTE,
    );
    expect(resultat.resultats[0]?.correspondances[0]?.groupesNommes).toEqual({ jour: "05", mois: "12" });
  });

  it("n'ajoute les groupes nommés que si le motif en déclare", async () => {
    const resultat = await outilDevRegex.execute(entree({ pattern: "b", chaines: ["abc"] }), CONTEXTE);
    expect(resultat.resultats[0]?.correspondances[0]?.groupesNommes).toBeUndefined();
  });

  it("respecte les drapeaux (i, m, pas de correspondance sans)", async () => {
    const sensible = await outilDevRegex.execute(entree({ pattern: "abc", chaines: ["XABCX"] }), CONTEXTE);
    expect(sensible.resultats[0]?.nombre).toBe(0);
    const insensible = await outilDevRegex.execute(entree({ pattern: "abc", drapeaux: "i", chaines: ["XABCX"] }), CONTEXTE);
    expect(insensible.resultats[0]?.nombre).toBe(1);
  });
});

describe("dev.regex — validation honnête", () => {
  it("signale un motif invalide avec le message de compilation", async () => {
    const resultat = await outilDevRegex.execute(entree({ pattern: "[invalide" }), CONTEXTE);
    expect(resultat.succes).toBe(false);
    expect(resultat.erreur).toMatch(/Motif ou drapeaux invalides/);
    expect(resultat.totalCorrespondances).toBe(0);
  });

  it("refuse des drapeaux inconnus ou doublés au schéma", () => {
    expect(outilDevRegex.inputSchema.safeParse({ pattern: "a", chaines: ["a"], drapeaux: "z" }).success).toBe(false);
    expect(outilDevRegex.inputSchema.safeParse({ pattern: "a", chaines: ["a"], drapeaux: "gg" }).success).toBe(false);
    expect(outilDevRegex.inputSchema.safeParse({ pattern: "a", chaines: ["a"], drapeaux: "gi" }).success).toBe(true);
  });

  it("refuse les entrées hors bornes (pattern, chaîne, nombre)", () => {
    expect(() => outilDevRegex.inputSchema.parse({ pattern: "x".repeat(2001), chaines: ["a"] })).toThrow();
    expect(() => outilDevRegex.inputSchema.parse({ pattern: "a", chaines: ["x".repeat(10_001)] })).toThrow();
    expect(() => outilDevRegex.inputSchema.parse({ pattern: "a", chaines: Array.from({ length: 101 }, () => "a") })).toThrow();
  });

  it("refuse honnêtement un total cumulé > 100 000 caractères", async () => {
    const chaines = Array.from({ length: 50 }, () => "x".repeat(3000));
    const resultat = await outilDevRegex.execute(entree({ pattern: "x", chaines }), CONTEXTE);
    expect(resultat.succes).toBe(false);
    expect(resultat.erreur).toMatch(/150000 caractères cumulés|Entrées trop volumineuses/);
  });
});

describe("dev.regex — sécurité ReDoS", () => {
  it("signale les quantificateurs imbriqués (avis heuristique honnête)", async () => {
    const resultat = await outilDevRegex.execute(
      entree({ pattern: "(a+)+b", chaines: ["aaaaaaaaaaaaaaaaaaaaab"] }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(true);
    expect(resultat.avisReDoS).toBe(true);
    expect(resultat.avis.some((a) => /quantificateurs imbriqués/.test(a))).toBe(true);
    expect(resultat.avis.some((a) => /pas une garantie|pas une garantie d'absence|peut être partiel/.test(a))).toBe(true);
  });

  it("n'active pas l'avis pour un motif sain", async () => {
    const resultat = await outilDevRegex.execute(entree({ pattern: "[a-z]+@exemple\\.(fr|com)" }), CONTEXTE);
    expect(resultat.avisReDoS).toBe(false);
  });

  it("échéance échue (deadlineMs=0) : aucun travail, partiel déclaré honnêtement", async () => {
    const resultat = await outilDevRegex.execute(
      entree({ pattern: "a", chaines: ["aaaa", "bbbb"], deadlineMs: 0 }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(true);
    expect(resultat.partiel).toBe(true);
    expect(resultat.totalCorrespondances).toBe(0);
    expect(resultat.resultats.every((r) => r.partiel === true)).toBe(true);
    expect(resultat.avis.some((a) => /incomplètes/.test(a))).toBe(true);
  });

  it("borne le nombre de correspondances par chaîne (tronque honnête)", async () => {
    const resultat = await outilDevRegex.execute(
      entree({ pattern: "a", chaines: ["a".repeat(5_000)] }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(true);
    expect(resultat.tronque).toBe(true);
    expect(resultat.resultats[0]?.tronque).toBe(true);
    expect(resultat.resultats[0]?.correspondances.length).toBeLessThanOrEqual(1_000);
  });

  it("ne boucle pas à l'infini sur un motif à correspondance vide (comportement JS standard)", async () => {
    const resultat = await outilDevRegex.execute(entree({ pattern: "a*", chaines: ["bbb"] }), CONTEXTE);
    expect(resultat.succes).toBe(true);
    // Sémantique JS réelle de /a*/g sur "bbb" : correspondance vide à chaque position.
    expect(resultat.resultats[0]?.correspondances).toEqual([
      { valeur: "", index: 0, groupes: [] },
      { valeur: "", index: 1, groupes: [] },
      { valeur: "", index: 2, groupes: [] },
      { valeur: "", index: 3, groupes: [] },
    ]);
  });
});

describe("dev.regex — découpage en fenêtres", () => {
  it("trouve les correspondances à travers les frontières de fenêtres longues", async () => {
    // Motif ancré à gauche : la correspondance commence juste après une frontière de fenêtre.
    const morceau = "b".repeat(1_200);
    const chaine = `${morceau}annuité-motif${"b".repeat(1_200)}`;
    const resultat = await outilDevRegex.execute(
      entree({ pattern: "annuité-motif", chaines: [chaine] }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(true);
    expect(resultat.resultats[0]?.nombre).toBe(1);
    expect(resultat.resultats[0]?.correspondances[0]?.index).toBe(1_200);
    expect(resultat.resultats[0]?.partiel).toBe(false);
  });

  it("déduplique les correspondances chevauchant deux fenêtres", async () => {
    const chaine = `${"x".repeat(1_500)}cible${"x".repeat(1_500)}`;
    const resultat = await outilDevRegex.execute(
      entree({ pattern: "cible", chaines: [chaine] }),
      CONTEXTE,
    );
    expect(resultat.resultats[0]?.nombre).toBe(1);
    expect(resultat.resultats[0]?.correspondances[0]?.index).toBe(1_500);
  });

  it("trouve toutes les occurrences d'une longue chaîne en fenêtres", async () => {
    // 15 segments joints par « JETON » → 14 occurrences ; 4 570 caractères → découpage actif.
    const chaine = Array.from({ length: 15 }, () => "x".repeat(300)).join("JETON");
    const resultat = await outilDevRegex.execute(
      entree({ pattern: "JETON", chaines: [chaine] }),
      CONTEXTE,
    );
    expect(resultat.resultats[0]?.nombre).toBe(14);
    expect(resultat.resultats[0]?.tronque).toBe(false);
    expect(resultat.avis.some((a) => /découpage actif/.test(a))).toBe(true);
  });
});

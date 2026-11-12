import { describe, expect, it } from "vitest";

import { detecterLangage, outilCodeInspect } from "./inspect";

/**
 * Tests de l'outil `code.inspect` — analyse statique légère. 100 %
 * déterministe : détection de langage, erreurs structurelles certaines,
 * comptages. Aucun réseau, aucune exécution de code.
 */

const CONTEXTE = { userId: "utilisateur-test", executionId: "exec-test" };

describe("outil code.inspect — détection de langage", () => {
  it("détecte html, json, ts, css et js", () => {
    expect(detecterLangage("<!doctype html><html><body></body></html>").langage).toBe("html");
    expect(detecterLangage('{"a": 1, "b": [2, 3]}').langage).toBe("json");
    expect(detecterLangage("interface Utilisateur { nom: string }").langage).toBe("ts");
    expect(detecterLangage(".carte { couleur: rouge; marge: 0; }").langage).toBe("css");
    expect(detecterLangage("const addition = (a, b) => a + b;").langage).toBe("js");
  });

  it("ne prend pas du JS objet pour du JSON (JSON.parse exigeant)", () => {
    expect(detecterLangage("{ a: 1 }").langage).toBe("js");
  });

  it("annonce honnêtement le cas du contenu vide", () => {
    const resultat = detecterLangage("   ");
    expect(resultat.langage).toBe("js");
    expect(resultat.avis).toMatch(/vide/i);
  });
});

describe("outil code.inspect — JavaScript/TypeScript", () => {
  it("compte les fonctions (déclarations + flèches) et les classes", async () => {
    const resultat = await outilCodeInspect.execute(
      outilCodeInspect.inputSchema.parse({
        contenu: [
          "function direBonjour() { return \"bonjour\"; }",
          "const saluer = () => \"salut\";",
          "class Point {}",
          "// direBonjour appelée ci-dessous dans une chaîne — ne compte pas :",
          "const texte = \"function pas comprise\";",
        ].join("\n"),
        langage: "js",
      }),
      CONTEXTE,
    );
    expect(resultat.valide).toBe(true);
    expect(resultat.stats.fonctions).toBe(2);
    expect(resultat.stats.classes).toBe(1);
  });

  it("signale une accolade ouvrante sans fermante avec la ligne", async () => {
    const resultat = await outilCodeInspect.execute(
      outilCodeInspect.inputSchema.parse({
        contenu: "function a() {\n  const b = 1;\n",
        langage: "js",
      }),
      CONTEXTE,
    );
    expect(resultat.valide).toBe(false);
    expect(resultat.stats.accoladesOuvertes).toBe(1);
    expect(resultat.stats.accoladesFermees).toBe(0);
    expect(resultat.stats.equilibre).toBe(false);
    expect(resultat.erreurs.some((e) => /accolade ouvrante/.test(e.message))).toBe(true);
  });

  it("signale une parenthèse fermante sans ouvrante", async () => {
    const resultat = await outilCodeInspect.execute(
      outilCodeInspect.inputSchema.parse({ contenu: "const x = 1);", langage: "js" }),
      CONTEXTE,
    );
    expect(resultat.valide).toBe(false);
    expect(resultat.erreurs.some((e) => /parenthèse fermante/.test(e.message))).toBe(true);
  });

  it("détecte une chaîne non terminée (apostrophe)", async () => {
    const resultat = await outilCodeInspect.execute(
      outilCodeInspect.inputSchema.parse({ contenu: "const mot = 'inacheve;\nconst ok = 1;", langage: "js" }),
      CONTEXTE,
    );
    expect(resultat.valide).toBe(false);
    expect(resultat.erreurs.some((e) => /non terminée/.test(e.message))).toBe(true);
  });

  it("détecte un commentaire bloc non terminé", async () => {
    const resultat = await outilCodeInspect.execute(
      outilCodeInspect.inputSchema.parse({ contenu: "/* jamais fermé", langage: "js" }),
      CONTEXTE,
    );
    expect(resultat.valide).toBe(false);
    expect(resultat.erreurs.some((e) => /commentaire \/\* non terminé/.test(e.message))).toBe(true);
  });

  it("n'est pas trompé par des délimiteurs dans les chaînes et commentaires", async () => {
    const resultat = await outilCodeInspect.execute(
      outilCodeInspect.inputSchema.parse({
        contenu: "const s = \"}{(\" ; // accolades décoratives } ) ]\nconst t = 1;",
        langage: "js",
      }),
      CONTEXTE,
    );
    expect(resultat.valide).toBe(true);
    expect(resultat.stats.accoladesOuvertes).toBe(0);
    expect(resultat.stats.accoladesFermees).toBe(0);
    expect(resultat.stats.fonctions).toBe(0);
  });

  it("analyse du TypeScript typé sans erreur structurelle", async () => {
    const resultat = await outilCodeInspect.execute(
      outilCodeInspect.inputSchema.parse({
        contenu: "interface U { nom: string; age?: number }\nconst u: U = { nom: \"x\", age: 2 };",
      }),
      CONTEXTE,
    );
    expect(resultat.langage).toBe("ts");
    expect(resultat.valide).toBe(true);
    expect(resultat.stats.fonctions).toBe(0);
  });
});

describe("outil code.inspect — HTML", () => {
  it("valide un document bien formé (balises vides auto-fermées)", async () => {
    const resultat = await outilCodeInspect.execute(
      outilCodeInspect.inputSchema.parse({
        contenu: "<div class=\"carte\"><h1>Titre</h1><img src=\"x.png\"><br><p>Texte</p></div>",
        langage: "html",
      }),
      CONTEXTE,
    );
    expect(resultat.valide).toBe(true);
    expect(resultat.html?.balisesOuvrantes).toBe(5);
    expect(resultat.html?.balisesAutoFermantes).toBe(2);
    expect(resultat.html?.balisesNonFermees).toEqual([]);
  });

  it("signale une balise jamais fermée et une balise orpheline", async () => {
    const resultat = await outilCodeInspect.execute(
      outilCodeInspect.inputSchema.parse({
        contenu: "<div><p>texte</div></span>",
        langage: "html",
      }),
      CONTEXTE,
    );
    expect(resultat.valide).toBe(false);
    expect(resultat.html?.balisesNonFermees).toContain("p");
    expect(resultat.html?.balisesOrphelines).toContain("span");
    expect(resultat.erreurs.length).toBeGreaterThanOrEqual(2);
  });

  it("signale un commentaire HTML non terminé", async () => {
    const resultat = await outilCodeInspect.execute(
      outilCodeInspect.inputSchema.parse({ contenu: "<!-- commentaire ouvert <div></div>", langage: "html" }),
      CONTEXTE,
    );
    expect(resultat.valide).toBe(false);
    expect(resultat.erreurs.some((e) => /commentaire <!-- non terminé/.test(e.message))).toBe(true);
  });

  it("ne compte pas les balises dans les commentaires fermés", async () => {
    const resultat = await outilCodeInspect.execute(
      outilCodeInspect.inputSchema.parse({
        contenu: "<!-- <div> caché </div> --><main></main>",
        langage: "html",
      }),
      CONTEXTE,
    );
    expect(resultat.html?.balisesOuvrantes).toBe(1);
    expect(resultat.valide).toBe(true);
  });
});

describe("outil code.inspect — JSON et CSS", () => {
  it("valide un JSON correct", async () => {
    const resultat = await outilCodeInspect.execute(
      outilCodeInspect.inputSchema.parse({ contenu: "{\"n\": [1, 2, {\"x\": null}]}", langage: "json" }),
      CONTEXTE,
    );
    expect(resultat.valide).toBe(true);
    expect(resultat.erreurs).toEqual([]);
  });

  it("signale un JSON invalide avec position honnête quand détectable", async () => {
    const resultat = await outilCodeInspect.execute(
      outilCodeInspect.inputSchema.parse({ contenu: "{\n  \"a\": 1,\n}\n", langage: "json" }),
      CONTEXTE,
    );
    expect(resultat.valide).toBe(false);
    expect(resultat.erreurs[0]?.message).toBeTruthy();
    // V8 fournit la position ; le numéro de ligne, s'il est présent, reste honnête (>= 1).
    if (resultat.erreurs[0]?.ligne !== undefined) expect(resultat.erreurs[0].ligne).toBeGreaterThanOrEqual(1);
    else expect(resultat.avis.join(" ")).toMatch(/json/i);
  });

  it("vérifie l'équilibre des accolades CSS sans compter de fonctions", async () => {
    const resultat = await outilCodeInspect.execute(
      outilCodeInspect.inputSchema.parse({
        contenu: ".carte { marge: 0; padding: 4px; }\n.pied {",
        langage: "css",
      }),
      CONTEXTE,
    );
    expect(resultat.langage).toBe("css");
    expect(resultat.valide).toBe(false);
    expect(resultat.stats.fonctions).toBe(0);
    expect(resultat.stats.equilibre).toBe(false);
  });
});

describe("outil code.inspect — honnêteté générale", () => {
  it("liste les limites de l'analyse dans les avis", async () => {
    const resultat = await outilCodeInspect.execute(
      outilCodeInspect.inputSchema.parse({ contenu: "const a = () => 1;", langage: "js" }),
      CONTEXTE,
    );
    expect(resultat.avis.some((a) => /pas de grammaire complète|pas de vérification de types/.test(a))).toBe(true);
  });

  it("refuse un contenu au-delà de la borne", () => {
    expect(() =>
      outilCodeInspect.inputSchema.parse({ contenu: "x".repeat(100_001) }),
    ).toThrow();
  });
});

import { describe, expect, it } from "vitest";

import { outilCodeExec } from "./exec";

/**
 * Tests de l'outil `code.exec` — exécution JS sandboxée (thread isolé +
 * node:vm durci). Les tests d'ÉVASION sont réels : ils s'exécutent dans la
 * vraie sandbox et vérifient qu'aucun accès hôte (process, fs, require,
 * Function, import) ne passe. Les tests n'accèdent à aucun réseau ni
 * fichier ; chaque exécution démarre un worker jetable (~30 ms).
 */

const CONTEXTE = { userId: "utilisateur-test", executionId: "exec-test" };

function entree(remplace: { code?: string; timeoutMs?: number } = {}) {
  return outilCodeExec.inputSchema.parse({ code: "1", ...remplace });
}

describe("outil code.exec — schéma d'entrée", () => {
  it("applique le timeout par défaut (2000 ms) et borne le code", () => {
    const analyse = outilCodeExec.inputSchema.parse({ code: "1 + 1" });
    expect(analyse.timeoutMs).toBe(2_000);
    expect(() =>
      outilCodeExec.inputSchema.parse({ code: `/* ${"x".repeat(100_001)} */` }),
    ).toThrow();
  });

  it("refuse timeoutMs > 2000 (timeout strict 2 s)", () => {
    expect(() => outilCodeExec.inputSchema.parse({ code: "1", timeoutMs: 5_000 })).toThrow();
    expect(() => outilCodeExec.inputSchema.parse({ code: "1", timeoutMs: 50 })).toThrow();
  });
});

describe("outil code.exec — exécution normale", () => {
  it("calcule une expression et renvoie la valeur de complétion", async () => {
    const resultat = await outilCodeExec.execute(entree({ code: "1 + 2 * 3" }), CONTEXTE);
    expect(resultat.succes).toBe(true);
    expect(resultat.valeur).toBe(7);
    expect(resultat.erreur).toBeUndefined();
  });

  it("exécute fonctions, classes et manipulations de données", async () => {
    const resultat = await outilCodeExec.execute(
      entree({
        code: `
          class Preuve { double(n) { return n * 2; } }
          const liste = [1, 2, 3].map(n => n * n);
          ({ liste, double: new Preuve().double(21) });
        `,
      }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(true);
    expect(resultat.valeur).toEqual({ liste: [1, 4, 9], double: 42 });
  });

  it("capture console.log dans stdout et console.error dans stderr", async () => {
    const resultat = await outilCodeExec.execute(
      entree({ code: `console.log("salut", { a: 1 }); console.error("oups"); "fin"` }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(true);
    expect(resultat.stdout).toEqual(['salut {"a":1}']);
    expect(resultat.stderr).toEqual(["oups"]);
  });

  it("borne la sortie console et signale tronque honnêtement", async () => {
    const resultat = await outilCodeExec.execute(
      entree({ code: "for (let i = 0; i < 500; i++) console.log(\"ligne-\" + i); \"fin\"" }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(true);
    expect(resultat.stdout.length).toBeLessThanOrEqual(200);
    expect(resultat.tronque).toBe(true);
  });
});

describe("outil code.exec — sécurité : évasions réelles bloquées", () => {
  it("bloque l'évasion classique this.constructor.constructor → process", async () => {
    const resultat = await outilCodeExec.execute(
      entree({ code: 'this.constructor.constructor("return process")().exit(1)' }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(false);
    expect(resultat.erreur).toBeDefined();
    expect(resultat.erreur).not.toContain("exit");
  });

  it("bloque l'évasion via Object ({})", async () => {
    const resultat = await outilCodeExec.execute(
      entree({ code: '({}).constructor.constructor("return process")().exit(1)' }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(false);
    expect(resultat.erreur).toBeDefined();
  });

  it("bloque l'évasion via AsyncFunction et GeneratorFunction", async () => {
    const asynchrone = await outilCodeExec.execute(
      entree({ code: '(async()=>{}).constructor.constructor("return process")().exit(1)' }),
      CONTEXTE,
    );
    const generateur = await outilCodeExec.execute(
      entree({ code: '(function*(){}).constructor.constructor("return process")().exit(1)' }),
      CONTEXTE,
    );
    expect(asynchrone.succes).toBe(false);
    expect(generateur.succes).toBe(false);
  });

  it("masque Function et eval (aucun eval indirect)", async () => {
    const fonction = await outilCodeExec.execute(
      entree({ code: 'Function("return process")().exit(1)' }),
      CONTEXTE,
    );
    const evalDirect = await outilCodeExec.execute(
      entree({ code: 'eval("process.exit(1)")' }),
      CONTEXTE,
    );
    const present = await outilCodeExec.execute(entree({ code: "typeof Function + '/' + typeof eval" }), CONTEXTE);
    expect(fonction.succes).toBe(false);
    expect(evalDirect.succes).toBe(false);
    expect(present.valeur).toBe("undefined/undefined");
  });

  it("n'expose ni process, ni require, ni Buffer, ni setTimeout", async () => {
    const resultat = await outilCodeExec.execute(
      entree({
        code: "typeof process + '/' + typeof require + '/' + typeof globalThis.Buffer + '/' + typeof setTimeout",
      }),
      CONTEXTE,
    );
    expect(resultat.valeur).toBe("undefined/undefined/undefined/undefined");
  });

  it("process.exit échoue proprement (process absent du contexte)", async () => {
    const resultat = await outilCodeExec.execute(entree({ code: "process.exit(1)" }), CONTEXTE);
    expect(resultat.succes).toBe(false);
    expect(resultat.erreur).toMatch(/process is not defined/);
  });

  it("require échoue proprement (aucun accès fs)", async () => {
    const resultat = await outilCodeExec.execute(entree({ code: 'require("fs")' }), CONTEXTE);
    expect(resultat.succes).toBe(false);
    expect(resultat.erreur).toMatch(/require is not defined/);
  });

  it("refuse le dynamique import() AVANT exécution (aucun worker lancé)", async () => {
    const resultat = await outilCodeExec.execute(
      entree({ code: 'import("node:fs").then(m => console.log(Object.keys(m).length))' }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(false);
    expect(resultat.erreur).toMatch(/import\(\).*interdit|interdit.*import\(\)/i);
    expect(resultat.dureeMs).toBeLessThan(30);
    expect(resultat.stdout).toEqual([]);
  });

  it("masque Promise (rejets non gérés impossibles via le constructeur)", async () => {
    const resultat = await outilCodeExec.execute(entree({ code: "typeof Promise" }), CONTEXTE);
    expect(resultat.valeur).toBe("undefined");
  });
});

describe("outil code.exec — timeout strict", () => {
  it("interrompt une boucle infinie et restitue un résultat honnête", async () => {
    const debut = Date.now();
    const resultat = await outilCodeExec.execute(
      entree({ code: "while (true) {}", timeoutMs: 200 }),
      CONTEXTE,
    );
    const duree = Date.now() - debut;
    expect(resultat.succes).toBe(false);
    expect(resultat.timeout).toBe(true);
    expect(resultat.erreur).toMatch(/timeout|interrompu|timed out/i);
    // Le timeout strict ne dépasse jamais largement la borne demandée.
    expect(duree).toBeLessThan(2_000);
  });

  it("signale une erreur de syntaxe honnêtement", async () => {
    const resultat = await outilCodeExec.execute(entree({ code: "const = ;" }), CONTEXTE);
    expect(resultat.succes).toBe(false);
    expect(resultat.erreur).toMatch(/Unexpected token/i);
  });
});

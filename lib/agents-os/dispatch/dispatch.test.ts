import { describe, it, expect } from "vitest";

import { executerTacheInterne, estTacheInterne, TYPES_TACHES } from "./registre-taches";
import { ExecuteurSandbox } from "./executeur-sandbox";

describe("Module 2 — dispatch : registre de tâches natives", () => {
  it("expose 4 tâches natives connues", () => {
    expect(TYPES_TACHES.sort()).toEqual(["http-scrape", "json-transform", "sha256", "text-extract"].sort());
    expect(estTacheInterne("sha256")).toBe(true);
    expect(estTacheInterne("rm-rf")).toBe(false);
  });

  it("sha256 : empreinte locale déterministe", async () => {
    const resultat = await executerTacheInterne({ taskType: "sha256", data: { contenu: "abc" } });
    expect(resultat.ok).toBe(true);
    // Empreinte SHA-256 de "abc" (référence publique NIST).
    expect((resultat.resultat as { sha256: string }).sha256).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("text-extract : extraction par regex nommée, bornée", async () => {
    const resultat = await executerTacheInterne({
      taskType: "text-extract",
      data: {
        texte: "prix: 12 EUR, stock: 7, prix: 30 EUR",
        motifs: { prix: "prix:\\s*(\\d+)" },
      },
    });
    expect(resultat.ok).toBe(true);
    expect((resultat.resultat as { extrait: { prix: string[] } }).extrait.prix).toEqual(["12", "30"]);
  });

  it("json-transform : lecture de chemins pointés sans eval", async () => {
    const resultat = await executerTacheInterne({
      taskType: "json-transform",
      data: {
        json: { a: { b: [10, 20] } },
        chemins: ["a.b[1]", "a.inexistant"],
      },
    });
    expect(resultat.ok).toBe(true);
    expect((resultat.resultat as { selection: Record<string, unknown> }).selection).toEqual({
      "a.b[1]": 20,
      "a.inexistant": undefined,
    });
  });

  it("taskType inconnu : échec propre avec message utile", async () => {
    const resultat = await executerTacheInterne({ taskType: "deploy-prod", data: {} });
    expect(resultat.ok).toBe(false);
    expect(resultat.erreur).toContain("taskType inconnu");
  });

  it("text-extract sans texte : erreur explicite", async () => {
    const resultat = await executerTacheInterne({ taskType: "text-extract", data: { motifs: {} } });
    expect(resultat.ok).toBe(false);
    expect(resultat.erreur).toContain("texte");
  });
});

describe("Module 2 — dispatch : sandbox (processus isolé)", () => {
  const sandbox = new ExecuteurSandbox({ timeoutMs: 10_000 });

  it("exécute un script simple et parse le résultat émis (emettre)", async () => {
    const resultat = await sandbox.executer(`
      const somme = donnees.a + donnees.b;
      emettre({ somme, mot: "ok" });
    `, { a: 2, b: 40 });
    expect(resultat.ok).toBe(true);
    expect(resultat.mode).toBe("processus");
    expect(resultat.resultat).toEqual({ somme: 42, mot: "ok" });
    expect(resultat.nettoye).toBe(true);
  }, 20_000);

  it("les console.log restent des LOGS (jamais confondus avec le résultat)", async () => {
    const resultat = await sandbox.executer(`
      console.log("du bruit");
      emettre({ ok: true });
    `);
    expect(resultat.ok).toBe(true);
    expect(resultat.resultat).toEqual({ ok: true });
    expect(resultat.logs).toContain("du bruit");
  }, 20_000);

  it("la DERNIÈRE émission emettre() gagne", async () => {
    const resultat = await sandbox.executer(`
      emettre({ version: 1 });
      emettre({ version: 2 });
    `);
    expect(resultat.resultat).toEqual({ version: 2 });
  }, 20_000);

  it("un script qui plante renvoie l'erreur proprement (pas de crash du père)", async () => {
    const resultat = await sandbox.executer(`throw new Error("boom intentionnel");`);
    expect(resultat.ok).toBe(false);
    expect(resultat.stderr).toContain("boom intentionnel");
  }, 20_000);

  it("un script sans emettre() échoue avec le message de contrat", async () => {
    const resultat = await sandbox.executer(`console.log("rien");`);
    expect(resultat.ok).toBe(false);
    expect(resultat.erreur).toContain("emettre");
  }, 20_000);

  it("timeout : un script interminable est tué (SIGTERM→SIGKILL)", async () => {
    const courte = new ExecuteurSandbox({ timeoutMs: 2_000 });
    const resultat = await courte.executer(`
      const t0 = Date.now();
      while (Date.now() - t0 < 60_000) { /* boucle interminable */ }
    `);
    expect(resultat.ok).toBe(false);
    expect(resultat.timeoutAtteint).toBe(true);
    expect(resultat.erreur).toContain("timeout");
  }, 20_000);

  it("script trop long : refus immédiat sans spawn", async () => {
    const stricte = new ExecuteurSandbox({ tailleScriptMax: 100 });
    const resultat = await stricte.executer("// " + "x".repeat(500));
    expect(resultat.ok).toBe(false);
    expect(resultat.erreur).toContain("dépasse");
  });

  it("script vide : refus immédiat", async () => {
    const resultat = await sandbox.executer("   ");
    expect(resultat.ok).toBe(false);
  });

  it("AUCUN fichier temporaire ne survit à l'exécution (cleanup garanti)", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const avant = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("agents-os-sandbox-"));
    await sandbox.executer(`emettre({ ok: 1 });`);
    // Laissons un souffle au finally (déjà awaité avant le retour).
    const apres = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("agents-os-sandbox-"));
    const nouveaux = apres.filter((d) => !avant.includes(d));
    expect(nouveaux).toEqual([]);
    void path;
  }, 20_000);
});

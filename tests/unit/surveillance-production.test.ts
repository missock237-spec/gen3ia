import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Garde-fou — SURVEILLANCE SYNTHÉTIQUE DE PRODUCTION (itération 24, Job 478451).
 *
 * Constat : le guérisseur surveille l'alignement main↔prod (version.json),
 * mais AUCUNE sonde ne vérifiait l'expérience utilisateur réelle (santé HTTP
 * des endpoints, TTFB) entre deux déploiements — une prod dégradée entre
 * deux pushes restait invisible.
 *
 * Ce test verrouille :
 * 1. le workflow (cron 7,37 décalé du guérisseur 17,47, permissions
 *    issues:write mesurée, anti-spam d'issue, clôture sur rétablissement) ;
 * 2. la sonde (10 endpoints conformes à la sonde de régression, seuils
 *    explicites, verdict fail-closed, pas de faux positif de livraison
 *    bloquée quand main n'a pas bougé) ;
 * 3. la syntaxe exécutable réelle (node --check).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("Workflow surveillance-production", () => {
  const wf = read(".github/workflows/surveillance-production.yml");

  it("cron décalé des autres workflows (7,37) + déclencheur manuel", () => {
    expect(wf).toContain("cron: '7,37 * * * *'");
    expect(wf).toContain("workflow_dispatch");
  });

  it("appelle bien la sonde et transmet les seuils", () => {
    expect(wf).toContain("node scripts/surveillance_prod.mjs");
    expect(wf).toContain("BASE_URL: https://gen3ia.online");
    expect(wf).toContain("MAX_TTFB_MS: '3000'");
    expect(wf).toContain("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });

  it("permissions mesurées (contents: read, issues: write) — pas plus", () => {
    expect(wf).toContain("contents: read");
    expect(wf).toContain("issues: write");
    const bloc = wf.split("permissions:")[1]?.split("concurrency:")[0] ?? "";
    expect(bloc).not.toMatch(/write-all|packages|deployments/);
  });

  it("cycle d'issue : label dédié, anti-spam (édition du corps), clôture RÉTABLI avec preuve", () => {
    expect(wf).toContain('LABEL="surveillance-prod"');
    expect(wf).toContain("gh issue edit");
    expect(wf).toContain("anti-spam");
    expect(wf).toContain("RÉTABLI");
    expect(wf).toContain("gh issue close");
    // Pas de création en doublon : create seulement si aucune ouverte
    expect(wf).toContain('gh issue create --title "$TITRE" --body-file results.md --label "$LABEL"');
    expect(wf.indexOf("OUVERTES")).toBeLessThan(wf.indexOf("gh issue create"));
  });

  it("concurrence sérielle et timeout borné", () => {
    expect(wf).toContain("group: surveillance-production");
    expect(wf).toContain("cancel-in-progress: false");
    expect(wf).toContain("timeout-minutes: 10");
  });
});

describe("Sonde surveillance_prod.mjs", () => {
  const sonde = read("scripts/surveillance_prod.mjs");
  const sondeRegression = read("scripts/sonde_regression_prod.mjs");

  it("syntaxe Node valide (node --check réel)", () => {
    expect(() =>
      execFileSync(process.execPath, ["--check", path.join(process.cwd(), "scripts/surveillance_prod.mjs")], {
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("sonde les 10 mêmes endpoints que la sonde de régression (parité verrouillée)", () => {
    const extraire = (src: string) =>
      [...src.matchAll(/\[["']([^"']+)["'],\s*["']([^"']+)["']\]/g)].map((m) => `${m[1]}=${m[2]}`);
    expect(extraire(sonde)).toEqual(extraire(sondeRegression));
  });

  it("verdict fail-closed : échec si endpoint non conforme, version illisible, ou livraison bloquée", () => {
    expect(sonde).toContain("process.exit(1)");
    expect(sonde).toContain("version.json illisible ou injoignable");
    expect(sonde).toContain("livraison bloquée");
  });

  it("pas de faux positif de livraison bloquée : lag SHA ET build > 3 h (sinon non bloquant)", () => {
    expect(sonde).toContain("LIVRAISON_BLOQUEE_HEURES = 3");
    expect(sonde).toContain("lagSha && ageBuildHeures > LIVRAISON_BLOQUEE_HEURES");
  });

  it("TTFB borné et configurable (défaut 3000 ms)", () => {
    expect(sonde).toContain("MAX_TTFB_MS ?? 3000");
  });

  it("aucun secret en dur (token passé par environnement)", () => {
    expect(sonde).toContain("process.env.GITHUB_TOKEN");
    expect(sonde).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
  });
});

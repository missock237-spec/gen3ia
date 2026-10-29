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

  it("it.31 — le canal d'alarme ne peut plus être cassé par un label absent", () => {
    // Incident réel du 2026-10-29 13:37Z : sonde ROUGE (health TTFB 3282 ms
    // > 3000) PUIS crash du step (« could not add label: 'surveillance-prod'
    // not found » → exit 1) : AUCUNE issue créée — alarme muette depuis
    // l'it.24. Verrou : le label est auto-réparé de façon idempotente
    // AVANT l'ouverture, et la création est secourue SANS label.
    const ouverture = wf.slice(
      wf.indexOf("Ouvrir ou mettre à jour"),
      wf.indexOf("Clôturer l'issue"),
    );
    expect(ouverture).toContain('gh label create "$LABEL"');
    expect(ouverture).toContain("--force || true");
    // Défense en profondeur : si la création avec label échoue malgré tout,
    // l'issue part SANS label (une alarme nue vaut mieux qu'aucune alarme).
    expect(ouverture).toContain('|| gh issue create --title "$TITRE" --body-file results.md');
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

  it("it.32 — tolérance post-swap : re-test UNIQUE des échecs 5xx/TTFB/ERR, jamais des 4xx", () => {
    // Série documentée : it.29 502 dans la fenêtre de swap, it.31 TTFB 3282 ms
    // ~6 min post-swap (rétabli 944 ms) — deux faux positifs de verdict.
    // Principe : réchauffement = passe au re-test ; vraie panne = persiste.
    expect(sonde).toContain("RETEST_DELAY_MS ?? 60_000");
    // Éligibilité limitée aux signatures transitoires (ERR réseau, 5xx, TTFB) —
    // un 4xx inattendu (route manquante, auth cassée) reste un ROUGE immédiat.
    expect(sonde).toContain('r.statut === "ERR"');
    expect(sonde).toContain("r.statut >= 500");
    expect(sonde).toContain('r.raison.startsWith("TTFB")');
    // TOUS les échecs doivent être éligibles (un seul 4xx → ROUGE immédiat).
    expect(sonde).toContain("echecsEndpoints.every(eligibleRetest)");
    // Fail-closed : version.json illisible et livraison bloquée ne sont
    // JAMAIS re-testées (par définition non transitoires).
    expect(sonde).toContain("!livraisonBloquee");
  });

  it("it.32 — le re-test est visible, jamais silencieux (log + results.md)", () => {
    // Une absorption de transitoire DOIT apparaître dans le log et le corps
    // d'issue — un VERT sans explication masquerait la fragilité observée.
    expect(sonde).toContain("re-test unique dans");
    expect(sonde).toContain("transitoire post-swap absorbé");
    expect(sonde).toContain("PERSISTE au re-test");
    expect(sonde).toContain("Tolérance post-swap (it.32)");
  });

  it("aucun secret en dur (token passé par environnement)", () => {
    expect(sonde).toContain("process.env.GITHUB_TOKEN");
    expect(sonde).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
  });
});

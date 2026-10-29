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
 * 3. la syntaxe exécutable réelle (node --check) ;
 * 4. it.34 — la cadence auto-armée : deploy-vps réarme la sonde à chaque
 *    livraison PROUVÉE, le guérisseur la réarme si elle s'endort — le cron
 *    fantôme (1 tick planifié en 3 jours) ne porte plus seul la cadence,
 *    et la surveillance ne dispatche elle-même rien (anti-boucle).
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

describe("it.34 — surveillance auto-armée (la cadence ne dépend plus du cron fantôme ni du réflexe manuel)", () => {
  // Constat à l'origine du verrou : 3 jours d'historique de surveillance =
  // 16 dispatchs MANUELS (réflexe des itérations) vs 1 SEUL tick planifié
  // (le 13:37Z de l'incident it.31). Congestion GitHub documentée chez
  // deploy-vps (00:43/01:13/01:47 perdus) ET chez le guérisseur : les
  // planifications sont droppées en masse. La cadence de monitorage ne
  // peut donc pas reposer sur le cron : elle doit être réarmée par les
  // événements qui, eux, arrivent — chaque livraison prouvée (deploy-vps)
  // et chaque push/cron survivant du guérisseur (relais d'endormissement).
  const deploy = read(".github/workflows/deploy-vps.yml");
  const guerisseur = read(".github/workflows/guerisseur-production.yml");
  const surveillance = read(".github/workflows/surveillance-production.yml");

  it("deploy-vps — permission actions:write ajoutée, mesurée (jamais write-all)", () => {
    expect(deploy).toContain("actions: write");
    expect(deploy).not.toContain("write-all");
  });

  it("deploy-vps — réarmement À LA SOURCE, après la livraison prouvée (verify_build)", () => {
    expect(deploy).toContain("Réarmer la surveillance (livraison prouvée)");
    // Le réarmement n'a de sens QUE si verify_build a prouvé que la prod
    // sert CE build : même condition `if` que la refermeture d'escalade —
    // jamais de sonde dispatchée sur une livraison non prouvée.
    const etape = deploy.slice(deploy.indexOf("Réarmer la surveillance (livraison prouvée)"));
    expect(etape.slice(0, 400)).toContain("steps.verify_build.outcome == 'success'");
    // POST dispatch sur main + retries bornés (3 × 20 s).
    expect(deploy).toContain("actions/workflows/surveillance-production.yml/dispatches");
    expect(deploy).toContain("-f ref=main");
    expect(deploy).toContain("for i in 1 2 3");
    // Position : APRÈS le step de vérification de bout en bout.
    expect(deploy.indexOf("Réarmer la surveillance (livraison prouvée)")).toBeGreaterThan(
      deploy.indexOf("Vérifier que la production sert ce build exact"),
    );
  });

  it("deploy-vps — l'échec du réarmement est BRUYANT (run ROUGE, jamais silencieux)", () => {
    // Leçon it.31 : une alarme silencieuse est un bug. Si la sonde ne peut
    // pas être réarmée après retries, le run doit mourir en rouge — perdre
    // la cadence en silence recréerait l'angle mort d'it.24.
    expect(deploy).toContain("::error::Surveillance NON réarmée après 3 tentatives");
  });

  it("guérisseur — relais de cadence : réarme la sonde si elle s'endort (> 50 min)", () => {
    expect(guerisseur).toContain("Relais de cadence");
    // Âge du dernier run = première entrée de l'historique (desc), seuil
    // 50 min > cadence visée 30 min avec marge pour les runs en cours.
    expect(guerisseur).toContain("surveillance-production.yml/runs?per_page=1");
    expect(guerisseur).toContain("-gt 50");
    expect(guerisseur).toContain("actions/workflows/surveillance-production.yml/dispatches");
    // Le relais vit dans le job `verifier` (tourne TOUJOURS, aligné ou
    // non) — PAS dans `guerir` (skippé quand la prod est alignée, exacte-
    // ment le moment où un relais serait utile).
    expect(guerisseur.indexOf("Relais de cadence")).toBeLessThan(guerisseur.indexOf("  guerir:"));
  });

  it("guérisseur — l'échec du relais est BRUYANT (distinct du fail-closed des escalades v6)", () => {
    // Nuance v6 : ici, échouer fort est VOLONTAIRE — un relais impossible
    // n'est pas une fausse alerte sur la prod, c'est la preuve que le
    // monitorage ne peut pas être garanti.
    expect(guerisseur).toContain("::error::Surveillance endormie");
    expect(guerisseur).toContain("exit 1");
  });

  it("anti-boucle : la surveillance elle-même ne dispatche aucun workflow", () => {
    // deploy-vps et le guérisseur dispatchent la surveillance ; la
    // surveillance ne dispatche RIEN (pas de cycle self-healer ↔ sonde).
    expect(surveillance).not.toContain("dispatches");
    // Et ses permissions restent mesurées : contents:read + issues:write,
    // SANS actions:write (elle n'en a pas l'usage ni le droit).
    expect(surveillance).not.toContain("actions: write");
  });
});

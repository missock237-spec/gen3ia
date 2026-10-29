import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Audit de production — §7 CI/CD et §4 Sécurité : pipeline de CI.
 *
 * Garde-fous structurels : le cache du build Next.js (.next/cache) doit
 * rester branché sur TOUS les jobs qui compilent (le build est l'étape la
 * plus lourde — plusieurs minutes à chaque run sans lui), et le SAST CodeQL
 * (flux de données : injections, XSS, chemins non vérifiés) doit rester
 * acté en plus du scan de secrets gitleaks. Toute suppression de l'un de
 * ces étages doit être une décision explicite, pas un oubli.
 *
 * Task 130 : le DAST OWASP ZAP (security.yml — scan hebdomadaire exécuté
 * contre la production) est couvert par les mêmes garde-fous structurels :
 * l'étage ne doit pas disparaître silencieusement, ses versions d'actions
 * suivent le standard du dépôt, et le rodage (continue-on-error) doit
 * rester une décision documentée.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

/** Extrait les versions (dédupliquées) d'une action GitHub dans un workflow. */
const versionsAction = (contenu: string, action: string) =>
  [...new Set([...contenu.matchAll(new RegExp(`${action}@(v\\d+)`, "g"))].map((m) => m[1]))];

describe("Pipeline CI (.github/workflows/ci.yml)", () => {
  const ci = read(".github/workflows/ci.yml");

  it("cache npm conservé (setup-node) sur les jobs", () => {
    expect(ci).toContain("cache: npm");
  });

  it("cache .next/cache branché sur les DEUX jobs qui buildent (ci + a11y)", () => {
    // 2 jobs × (path + key) : le comptage protège contre la suppression
    // silencieuse de l'un des deux branchements.
    expect(ci.split("path: .next/cache").length - 1).toBe(2);
    expect(ci.split("key: nextjs-").length - 1).toBe(2);
    // restore-keys : réutilise le dernier cache connu même si le SHA diffère.
    expect(ci.match(/restore-keys: \|\n\s+nextjs-/g)?.length).toBe(2);
  });

  it("aucune régression : audit deps, typecheck, lint, tests avec seuils, budget bundle", () => {
    expect(ci).toContain("npm audit --omit=dev --audit-level=high");
    expect(ci).toContain("npm run typecheck");
    expect(ci).toContain("npm run lint");
    expect(ci).toContain("npm run test:coverage");
    expect(ci).toContain("npm run check:bundle");
  });

  it("scan de secrets gitleaks toujours présent (historique complet)", () => {
    expect(ci).toContain("gitleaks/gitleaks-action@v3");
    expect(ci).toContain("fetch-depth: 0");
  });
});

describe("SAST CodeQL (.github/workflows/codeql.yml)", () => {
  const codeql = read(".github/workflows/codeql.yml");

  it("déclencheurs : push + PR sur main + hebdomadaire (lundi 03:00 UTC)", () => {
    expect(codeql).toContain('branches: [main]');
    expect(codeql).toContain('cron: "0 3 * * 1"');
  });

  it("langage javascript-typescript avec la suite security-extended", () => {
    expect(codeql).toContain("languages: javascript-typescript");
    expect(codeql).toContain("queries: security-extended");
  });

  it("permissions minimales : security-events: write + contents: read (moindre privilège)", () => {
    expect(codeql).toContain("security-events: write");
    expect(codeql).toContain("contents: read");
  });

  it("actions CodeQL v3 : init → autobuild → analyze (catégorie verrouillée)", () => {
    expect(codeql).toContain("github/codeql-action/init@v3");
    expect(codeql).toContain("github/codeql-action/autobuild@v3");
    expect(codeql).toContain("github/codeql-action/analyze@v3");
    expect(codeql).toContain('category: "/language:javascript-typescript"');
  });
});

describe("Inventaire des workflows (.github/workflows/)", () => {
  // Toute addition/suppression de workflow doit passer par la mise à jour
  // explicite de cette liste — un workflow est une surface d'exécution
  // (secrets, permissions, accès production), pas un fichier anodin.
  it("exactement huit workflows : CI, CodeQL, Security, Deploy VPS, Guérisseur production, Load test (manuel), Ménage des branches et Surveillance production", () => {
    const workflows = readdirSync(path.join(process.cwd(), ".github/workflows"))
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .sort();
    expect(workflows).toEqual([
      "ci.yml",
      "codeql.yml",
      "deploy-vps.yml",
      "guerisseur-production.yml",
      "load-test.yml",
      "menage-branches.yml",
      "security.yml",
      "surveillance-production.yml",
    ]);
  });
});

describe("Guérisseur production (.github/workflows/guerisseur-production.yml)", () => {
  const guerisseur = read(".github/workflows/guerisseur-production.yml");

  it("déclencheurs : push main + schedule décalé hors heures pleines + manuel", () => {
    // Le cron évite les heures pleines (congestion GitHub documentée —
    // ticks 23:30/00:00 du cron */30 perdus le 27-28 oct. 2026) ET les
    // minutes :13/:43 (ticks 00:43/01:13 perdus le 29 oct. 2026).
    expect(guerisseur).toContain("branches: [main]");
    expect(guerisseur).toContain("cron: '17,47 * * * *'");
    expect(guerisseur).toContain("workflow_dispatch:");
  });

  it("v5 anti-faux-positif : re-mesure fraîche de la prod AVANT toute escalade", () => {
    // Fait constaté 00:27 UTC le 29 oct. : l'escalade a commenté
    // « toujours en retard » avec le SHA du job verifier (mesuré ~5 min
    // plus tôt) ALORS que le CD du même push avait déjà livré main à
    // 00:25:36. L'escalade doit donc re-mesurer la production elle-même
    // (3 lectures espacées, cache-buster) avant tout bruit, et refermer
    // l'issue si l'alignement est détecté entre-temps.
    expect(guerisseur).toContain("version.json?rm=");
    expect(guerisseur).toContain("RE-MESURE FRAÎCHE");
    expect(guerisseur).toContain("SHA_PROD_REEL");
    expect(guerisseur).toContain("alignement détecté par re-mesure fraîche");
    // Le commentaire de tick doit porter le SHA re-mesuré, jamais le SHA
    // périmé du verifier.
    expect(guerisseur).toContain("SHA_PROD=\"${SHA_PROD_REEL:-$SHA_PROD}\"");
    expect(guerisseur).toContain("re-mesuré à");
  });

  it("v5 garde « CD en cours » : pas d'escalade pendant une livraison légitime", () => {
    // Un run deploy-vps in_progress/queued sur le SHA de main est un canal
    // de livraison légitime — escalader « poller inactif » pendant ce
    // temps = faux positif garanti (constaté 00:27 UTC le 29 oct.).
    expect(guerisseur).toContain("CD_EN_COURS");
    expect(guerisseur).toContain(
      "actions/workflows/deploy-vps.yml/runs?per_page=10",
    );
    expect(guerisseur).toContain(
      "pas d'escalade ce tick (livraison possible en cours)",
    );
  });

  it("v6 garde fail-closed : API muette = renonciation à l'escalade, jamais de faux positif", () => {
    // Fait constaté 01:45 UTC le 29 oct. : l'appel API « runs du CD » a
    // échoué (rate limit) et le repli « || echo 0 » a FAIL-OPEN → escalade
    // #108 créée pendant que le CD du même push livrait (swap ~1 min
    // après). La garde doit réessayer 3× puis RENONCER à escalader ce tick
    // (fail-closed) — et le filtre couvre les états d'attente des files de
    // concurrency (waiting/pending), pas seulement in_progress/queued.
    expect(guerisseur).toContain("GARDE FAIL-CLOSED");
    expect(guerisseur).toContain(
      "État du CD indéterminable (API injoignable 3×)",
    );
    expect(guerisseur).toContain("garde fail-closed");
    expect(guerisseur).toContain('or .status=="waiting" or .status=="pending"');
  });

  it("v6.1 seuil du watchdog : diagnostic « poller inactif » interdit avant 10 min d'âge release", () => {
    // Constat du 29 oct. : toute la journée, les ticks ont clamé « publiée
    // il y a 0 min … poller inactif » alors que le poller VPS livrait en
    // ~10 min (téléchargement ~205 Mo + swap). Le diagnostic « poller
    // inactif » exige que la release ait eu le temps d'être téléchargée
    // et basculée (≥ 10 min = 5 cycles de 2 min + marge) ; avant ce seuil,
    // le tick se tait et réévalue. Âge non numérique → 0 (bash -e safe).
    expect(guerisseur).toContain("SEUIL DU WATCHDOG");
    expect(guerisseur).toContain("Release trop récente (");
    expect(guerisseur).toContain("case $AGE_RELEASE in ''|*[!0-9]*) AGE_RELEASE=0 ;; esac");
    expect(guerisseur).toContain('"$AGE_RELEASE" -lt 10');
  });

  it("anti-collision CD : garde runs en cours/échoués + concurrency sérielle", () => {
    expect(guerisseur).toContain("group: guerisseur-production");
    expect(guerisseur).toContain("cancel-in-progress: false");
    expect(guerisseur).toContain("EN_COURS");
    expect(guerisseur).toContain("DERNIER_CE_SHA");
  });

  it("armement du canal pull (poller idempotent) + secours CD explicites", () => {
    expect(guerisseur).toContain("install-pull-mode.sh");
    expect(guerisseur).toContain("gh workflow run deploy-vps.yml");
  });

  it("v6.2 secours SANS SSH : renouvellement d'IP runner quand release à jour + âge ≥ 10 min + SSH muet", () => {
    // Constat 07:26→08:10Z (itération 26) : release cd-latest à jour,
    // poller silencieux, SSH muet → prod gelée ~45 min ; la livraison
    // n'a été rétablie que par un dispatch CD MANUEL (IP runner neuve).
    // Le guérisseur doit savoir faire ce que l'opérateur a fait à la main.
    expect(guerisseur).toContain("Secours sans SSH — redéclencher le CD (renouvellement d'IP runner)");
    const secours = guerisseur.split("id: secours-ip")[1]?.split("- name: Rapport du tick")[0] ?? "";
    // Conditions conjonctives strictes (anti-spam) — les trois doivent coexister :
    expect(secours).toContain("steps.sonde.outputs.joignable != 'oui'");
    expect(secours).toContain("steps.release.outputs.release_sha == needs.verifier.outputs.sha_main");
    expect(secours).toContain(">= 10");
    // C'est bien un dispatch CD (canal à IP renouvelée), pas un appel SSH direct.
    expect(secours).toContain("gh workflow run deploy-vps.yml");
    // Observabilité : le rapport du tick trace le secours.
    expect(guerisseur).toContain("secours-ip =");
  });

  it("v6.2 garde d'escalade : pas d'issue si le secours vient de s'armer ce tick (anti-race API)", () => {
    // Le CD dispatched construit ~6-8 min avant de livrer ; le garde
    // « CD en cours » (API) ne le verrait pas encore — l'escalade ne
    // peut pas brailler le même tick où l'action vient d'être prise.
    expect(guerisseur).toContain("GARDE « SECOURS VENANT DE S'ARMER »");
    expect(guerisseur).toContain("steps.secours-ip.outcome");
  });

  it("permissions minimales : contents: read + actions: write (moindre privilège)", () => {
    expect(guerisseur).toContain("contents: read");
    expect(guerisseur).toContain("actions: write");
  });
});

describe("CD VPS (.github/workflows/deploy-vps.yml) — refermeture à la source", () => {
  const cd = read(".github/workflows/deploy-vps.yml");

  it("permissions : contents: write (release) + issues: write (refermeture)", () => {
    // Moindre privilège étendu de façon mesurée : issues:write n'existe
    // que (v6, itération 21) pour refermer l'escalade après livraison
    // prouvée — aucune autre écriture d'issue dans le workflow.
    expect(cd).toContain("contents: write");
    expect(cd).toContain("issues: write");
  });

  it("v6 : l'escalade est refermée APRÈS la vérification de bout en bout du build", () => {
    // L'acteur qui PROUVE la livraison (verify_build : deploy-info +
    // version.json alignés) referme l'escalade lui-même — sans dépendre
    // d'un tick guérisseur ultérieur (ticks cron perdus : 00:43, 01:13,
    // 01:47 le 29 oct. 2026 → escalades périmées laissées ouvertes).
    expect(cd).toContain(
      "Refermer l'escalade production ↔ main (livraison prouvée)",
    );
    expect(cd).toContain("steps.verify_build.outcome == 'success'");
    expect(cd).toContain(
      "Escalade refermée À LA SOURCE par le déploiement continu",
    );
    // L'ordre compte : la refermeture suit STRICTEMENT la vérification.
    const verif = cd.indexOf("Vérifier que la production sert ce build exact");
    const fermeture = cd.indexOf("Refermer l'escalade production ↔ main");
    expect(verif).toBeGreaterThan(-1);
    expect(fermeture).toBeGreaterThan(verif);
  });

  it("refermeture non bloquante : un échec de clôture n'annule jamais un déploiement réussi", () => {
    expect(cd).toContain(
      "Refermeture impossible (quota API ?) — un tick guérisseur la refermera",
    );
  });
});

describe("Scan OWASP ZAP (.github/workflows/security.yml)", () => {
  const security = read(".github/workflows/security.yml");

  it("déclencheurs : hebdomadaire (dimanche 03:20 UTC, décalé du scan CodeQL) + manuel", () => {
    expect(security).toContain('cron: "20 3 * * 0"');
    expect(security).toContain("workflow_dispatch:");
    // Input target_url : cible surchargeable à la demande, production par défaut.
    expect(security).toContain("target_url");
    expect(security).toContain("type: string");
    expect(security).toContain("https://gen3ia.online");
  });

  it("scan ZAP baseline épinglé, cible = input manuel avec repli production", () => {
    // Action officielle OWASP ZAP — version épinglée, jamais une balise
    // flottante (un scan de sécurité reproductible).
    expect(security).toContain("zaproxy/action-baseline@v0.15.0");
    expect(security).toContain(
      "target: ${{ inputs.target_url || 'https://gen3ia.online' }}",
    );
    // Pas de ticket GitHub automatique : cohérent avec le moindre privilège
    // `contents: read` (écrire des tickets exigerait `issues: write`).
    expect(security).toContain("allow_issue_writing: false");
  });

  it("phase de rodage documentée : étape ZAP non bloquante (continue-on-error)", () => {
    expect(security).toContain("continue-on-error: true");
  });

  it("charge maîtrisée sur la production : spider et plafond bornés", () => {
    // -m : minutes de spider (défaut 1) ; -T : plafond global du scan passif.
    expect(security).toContain('cmd_options: "-m 3 -T 8"');
  });

  it("permissions minimales contents: read + concurrency anti-chevauchement", () => {
    expect(security).toContain("contents: read");
    expect(security).toContain("group: security-zap");
    expect(security).toContain("cancel-in-progress: true");
  });

  it("rapport ZAP publié en artefact via upload-artifact v7, même si le scan échoue", () => {
    expect(security).toContain("actions/upload-artifact@v7");
    // if: always() — le rapport est préservé pour triage même quand l'étape
    // ZAP est en échec (rodage, continue-on-error).
    expect(security).toContain("if: always()");
    expect(security).toContain("name: rapport-zap");
    expect(security).toContain("report_json.json");
    expect(security).toContain("if-no-files-found: warn");
  });

  it("versions d'actions alignées sur le standard du dépôt (cf. ci.yml)", () => {
    const ci = read(".github/workflows/ci.yml");
    // checkout suit strictement la/les version(s) en vigueur dans ci.yml —
    // une divergence (ex. v6 dans security.yml, v7 ailleurs) est une
    // incohérence de maintenance à corriger immédiatement.
    expect(versionsAction(security, "actions/checkout")).toEqual(
      versionsAction(ci, "actions/checkout"),
    );
    // upload-artifact suit le standard v7 du dépôt (l'action n'est pas
    // référencée dans ci.yml : la version est donc verrouillée ici).
    expect(versionsAction(security, "actions/upload-artifact")).toEqual(["v7"]);
  });
});

describe("Couplage guérisseur → surveillance (it. 28 — crons GitHub défaillants)", () => {
  const guerisseur = read(".github/workflows/guerisseur-production.yml");

  it("le guérisseur dispatch la sonde HTTP en fin de run (déclencheur événementiel)", () => {
    // Constat it.28 : les crons GitHub du dépôt sont massivement sautés
    // (surveillance : 0 run cron sur 4 slots 08:37→10:07Z ; guérisseur :
    // 1 run schedule sur 8) — la sonde it. 24 ne s'exécutait jamais en
    // cron. Le couplage événementiel (fin du guérisseur, lui-même
    // déclenché à chaque push) garantit une sonde HTTP après chaque
    // évaluation de production, sans dépendre du scheduler GitHub.
    expect(guerisseur).toContain("sonder:");
    expect(guerisseur).toContain("gh workflow run surveillance-production.yml");
    expect(guerisseur).toContain("needs: [verifier, guerir]");
    // Le dispatch s'exécute même si la réparation a échoué (la mesure
    // HTTP est justement la plus précieuse quand quelque chose casse) —
    // mais jamais si le run est annulé.
    expect(guerisseur).toContain("if: always() && !cancelled()");
    // Un échec de dispatch ne rend PAS le guérisseur rouge (le filet
    // cron 7,37 reste en place).
    expect(guerisseur).toContain("continue-on-error: true");
  });

  it("la surveillance garde son déclencheur cron ET son dispatch manuel (filet)", () => {
    const surveillance = read(".github/workflows/surveillance-production.yml");
    expect(surveillance).toContain("cron: '7,37 * * * *'");
    expect(surveillance).toContain("workflow_dispatch");
  });
});

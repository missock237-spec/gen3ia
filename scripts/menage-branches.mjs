#!/usr/bin/env node
/**
 * MÉNAGE DES BRANCHES FUSIONNÉES — Gen3ia (Task M, zéro dépendance npm).
 *
 * Combattre la dérive des branches longues (Trunk-Based Development,
 * docs/processus-ingenierie.md §2) : toute branche distante dont le tip est
 * ANCÊTRE de `main` est supprimée automatiquement après fusion. Une branche
 * qui traîne après merge est un artefact (branche « fantôme ») : elle
 * suggère un travail en cours alors que `main` contient déjà tout.
 *
 * DÉTECTION :
 *   1. `git fetch --prune origin`          — refs distantes à jour ;
 *   2. `git ls-remote --heads origin`      — branches distantes + tips SHA ;
 *   3. `git merge-base --is-ancestor <tip> origin/main` pour chaque branche
 *      ≠ main — code 0 = tip fusionné dans main (supprimable) ;
 *   4. VÉRIFICATION ANTI-COURSE : le SHA du tip est re-vérifié par un
 *      second ls-remote juste avant suppression — si quelqu'un a poussé
 *      entre-temps, la branche est CONSERVÉE (on ne détruit jamais un
 *      travail qui n'est plus celui qu'on a analysé).
 *
 * SUPPRESSION : API GitHub REST
 *   DELETE /repos/{owner}/{repo}/git/refs/heads/{branche}
 *   avec GITHUB_TOKEN (fourni par le workflow, permissions contents: write).
 *
 * MODES :
 *   DRY_RUN=1 (DÉFAUT) — n'affiche que ce qui serait fait : sûr en local.
 *   DRY_RUN=0          — exécute les suppressions (workflow menage-branches).
 *
 * SORTIE : 0 si tout s'est bien passé, 1 si au moins une suppression a
 * échoué (visibilité en CI — une branche non supprimable doit être réglée
 * à la main, pas oubliée en silence).
 */

import { execFileSync, spawnSync } from "node:child_process";

/** Branches JAMAIS touchées (le trunk et ses sentinelles). */
const BRANCHES_PROTEGEES = new Set(["main"]);

/** Exécute git, renvoie stdout (échec = exception avec stderr). */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Exécute git SANS lever : renvoie le code de sortie (pour --is-ancestor). */
function gitCode(args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return r.status ?? 1;
}

/** Détermine « owner/repo » : GITHUB_REPOSITORY (CI) sinon l'URL d'origin. */
function resoudreDepot() {
  const depuisEnv = process.env.GITHUB_REPOSITORY;
  if (depuisEnv && /^[^/\s]+\/[^/\s]+$/.test(depuisEnv.trim())) {
    return depuisEnv.trim();
  }
  const url = git(["remote", "get-url", "origin"]);
  // https://github.com/owner/repo.git | git@github.com:owner/repo.git
  const m = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) {
    throw new Error(
      `Impossible de déterminer « owner/repo » depuis origin (${url}) — ` +
        `définir GITHUB_REPOSITORY.`,
    );
  }
  return `${m[1]}/${m[2]}`;
}

/** Parse la sortie de `git ls-remote --heads origin` → Map nom → SHA. */
function parserHeads(sortie) {
  const heads = new Map();
  for (const ligne of sortie.split("\n")) {
    const l = ligne.trim();
    if (!l) continue;
    const [sha, ref] = l.split(/\t+/);
    if (!sha || !ref || !ref.startsWith("refs/heads/")) continue;
    heads.set(ref.slice("refs/heads/".length), sha);
  }
  return heads;
}

/** Supprime une branche via l'API GitHub (retourne true si OK). */
async function supprimerBranche(depot, branche, token) {
  const url =
    `https://api.github.com/repos/${depot}/git/refs/heads/${encodeURIComponent(branche)}`;
  const reponse = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gen3ia-menage-branches",
    },
  });
  if (reponse.status === 204) return { ok: true };
  if (reponse.status === 422) {
    // Référence déjà disparue (course avec un autre ménage) : non-blocant.
    return { ok: true, dejaAbsente: true };
  }
  const corps = await reponse.text().catch(() => "");
  return { ok: false, statut: reponse.status, corps: corps.slice(0, 300) };
}

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  const depot = resoudreDepot();
  const token = process.env.GITHUB_TOKEN?.trim() ?? "";

  console.log(
    `ménage: Dépôt ${depot} — mode ${dryRun ? "DRY-RUN (aucune suppression)" : "EXÉCUTION"}`,
  );

  // Étape 1 : refs à jour (fetch --prune : les branches supprimées côté
  // GitHub disparaissent des refs de tracking locales).
  git(["fetch", "--prune", "origin"]);

  // Étape 2 : branches distantes réelles + tips.
  const heads = parserHeads(git(["ls-remote", "--heads", "origin"]));
  if (!heads.has("main")) {
    throw new Error("Branche main introuvable sur origin — état anormal, abandon.");
  }
  console.log(`ménage: ${heads.size} branche(s) distante(s) sur origin (y compris main).`);

  let supprimees = 0;
  let conservees = 0;
  let protegees = 0;
  let echecs = 0;

  for (const branche of [...heads.keys()].sort()) {
    const sha = heads.get(branche);
    if (BRANCHES_PROTEGEES.has(branche)) {
      protegees += 1;
      console.log(`ménage: Protégée  ${branche} (trunk — jamais supprimée).`);
      continue;
    }

    // Étape 3 : le tip est-il ancêtre de main ? (0 = oui, 1 = non)
    const ancetre = gitCode(["merge-base", "--is-ancestor", sha, "origin/main"]);
    if (ancetre !== 0) {
      conservees += 1;
      console.log(
        `ménage: Conservée ${branche} — non fusionnée dans main ` +
          `(travail en cours ou branche orpheline).`,
      );
      continue;
    }

    // Étape 4 : anti-course — le SHA distant a-t-il bougé depuis l'analyse ?
    const headsFrais = parserHeads(git(["ls-remote", "--heads", "origin", `refs/heads/${branche}`]));
    const shaFrais = headsFrais.get(branche);
    if (shaFrais !== sha) {
      conservees += 1;
      console.log(
        `ménage: Conservée ${branche} — le tip a changé pendant l'analyse ` +
          `(${sha.slice(0, 7)} → ${shaFrais?.slice(0, 7) ?? "supprimée"}) : réévaluer au prochain passage.`,
      );
      continue;
    }

    if (dryRun) {
      console.log(
        `ménage: Serait supprimée ${branche} (tip ${sha.slice(0, 7)} fusionné dans main) — DRY-RUN.`,
      );
      supprimees += 1;
      continue;
    }

    if (!token) {
      echecs += 1;
      console.error(
        `ménage: ERREUR ${branche} — GITHUB_TOKEN absent : suppression impossible ` +
          `(DRY_RUN=0 exige le token, fourni par le workflow menage-branches).`,
      );
      continue;
    }

    const resultat = await supprimerBranche(depot, branche, token);
    if (resultat.ok) {
      supprimees += 1;
      console.log(
        `ménage: Supprimée  ${branche} (tip ${sha.slice(0, 7)} fusionné dans main)` +
          (resultat.dejaAbsente ? " — déjà absente côté GitHub." : "."),
      );
    } else {
      echecs += 1;
      console.error(
        `ménage: ERREUR ${branche} — API GitHub ${resultat.statut} : ${resultat.corps}`,
      );
    }
  }

  console.log(
    `ménage: Bilan : ${supprimees} supprimée(s), ${conservees} conservée(s), ` +
      `${protegees} protégée(s)` +
      (echecs > 0 ? `, ${echecs} ÉCHEC(S)` : "") +
      (dryRun ? " (dry-run : rien n'a été supprimé)" : "") +
      ".",
  );
  if (echecs > 0) process.exitCode = 1;
}

main().catch((erreur) => {
  console.error(`ménage: Échec du script : ${erreur instanceof Error ? erreur.message : erreur}`);
  process.exitCode = 1;
});

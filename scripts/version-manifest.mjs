#!/usr/bin/env node
/**
 * Manifeste de version — mise à jour forcée côté navigateur (plan 4 étapes,
 * demande utilisateur 2026-10-23).
 *
 * Chaque build écrit `public/version.json` : le client (DeployWatcher)
 * le sonde avec un cache-buster et recharge le navigateur dès que la
 * version servie diffère de celle qu'il connaît. Ce fichier complète
 * `/api/deploy-info` (empreinte BUILD_ID lue à la requête) :
 *   · il est STATIQUE — servi même si la couche route/middleware a un
 *     incident, et lisible directement par nginx (runbook §8) ;
 *   · sa `version` finale est EXACTEMENT le .next/BUILD_ID du build —
 *     une seule source de vérité, aucun écart possible entre les deux
 *     sondes.
 *
 * Deux phases, appelées par `npm run build` :
 *   init      — AVANT `next build`  : manifeste provisoire (sha git +
 *               timestamp, cf. plan utilisateur « version: Date.now() ») ;
 *               garantit qu'un fichier est toujours présent, y compris
 *               en dev (le fichier est gitignored).
 *   finalize  — APRÈS `next build`  : `version` = .next/BUILD_ID, puis
 *               copie du manifeste dans `.next/version.json` — le tar CD
 *               ne contient que .next (deploy-vps.yml), c'est donc par là
 *               que le manifeste rejoint le VPS, où cd-finisher.sh le
 *               copie dans public/ après son `git reset --hard`.
 *
 * Fonctions exportées pour la testabilité (app/version-manifest.test.ts) ;
 * en import (vitest), AUCUN effet de bord : le mode CLI ne s'active que
 * lorsque CE fichier est le point d'entrée de node.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

/** Chemin du manifeste servi (gitignored — artefact de build). */
export const MANIFEST_RELPATH = join("public", "version.json");
/** Copie embarquée dans le tar CD (extrait par cd-finisher.sh). */
export const SHIP_RELPATH = join(".next", "version.json");

/** SHA du commit courant, ou null hors dépôt git (JAMAIS d'exception). */
function readGitSha() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** Lit .next/BUILD_ID, ou null s'il est absent (dev sans build). */
export function readBuildIdFile(root) {
  try {
    const raw = readFileSync(join(root, ".next", "BUILD_ID"), "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Manifeste à écrire. `phase` « build » = provisoire (pré-build, la
 * valeur définitive n'existe pas encore) ; « production » = aligné sur le
 * BUILD_ID réel du build qui vient de se terminer.
 */
export function buildManifest({ buildId = null, gitSha = null, now = new Date() } = {}) {
  const production = buildId !== null;
  return {
    // version = empreinte unique du build (le BUILD_ID en production,
    // sha court + timestamp en provisoire — uniques par construction).
    version: production ? buildId : `${(gitSha ?? "nogit").slice(0, 7)}.${now.getTime()}`,
    buildDate: now.toISOString(),
    gitSha,
    buildId,
    phase: production ? "production" : "build",
  };
}

/** Phase init (pré-build) : manifeste provisoire garanti présent. */
export function initManifest(root, { now = new Date() } = {}) {
  const manifest = buildManifest({ gitSha: readGitSha(), now });
  const target = join(root, MANIFEST_RELPATH);
  mkdirSync(join(root, "public"), { recursive: true });
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Phase finalize (post-build) : aligne la version sur le BUILD_ID réel et
 * copie le manifeste dans .next/ pour l'embarquement CD. Sans BUILD_ID
 * (build interrompu, dev) : le provisoire d'init est conservé TEL QUEL
 * (version et buildDate stables — aucun écart entre les deux phases),
 * sans lever d'exception ; rien n'est embarqué puisqu'il n'y a pas de
 * build à livrer — le workflow vérifie de toute façon .next/BUILD_ID
 * juste après.
 */
export function finalizeManifest(root, { now = new Date() } = {}) {
  const buildId = readBuildIdFile(root);
  const provisional = readManifest(root);
  if (buildId === null) {
    if (provisional) return provisional;
    const fallback = buildManifest({ gitSha: readGitSha(), now });
    mkdirSync(join(root, "public"), { recursive: true });
    writeFileSync(join(root, MANIFEST_RELPATH), `${JSON.stringify(fallback, null, 2)}\n`);
    return fallback;
  }
  const manifest = buildManifest({
    buildId,
    gitSha: provisional?.gitSha ?? readGitSha(),
    now,
  });
  const target = join(root, MANIFEST_RELPATH);
  if (!existsSync(join(root, "public"))) mkdirSync(join(root, "public"), { recursive: true });
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
  // Le tar CD ne contient que .next : embarquer le manifeste à côté du
  // BUILD_ID — cd-finisher.sh le recopiera dans public/ sur le VPS.
  mkdirSync(join(root, ".next"), { recursive: true });
  copyFileSync(target, join(root, SHIP_RELPATH));
  return manifest;
}

/** Lit le manifeste courant, ou null (fichier absent/corrompu). */
export function readManifest(root) {
  try {
    return JSON.parse(readFileSync(join(root, MANIFEST_RELPATH), "utf8"));
  } catch {
    return null;
  }
}

/* --------------------------- Mode CLI uniquement ------------------------- */

const invokedDirectly = (() => {
  try {
    return Boolean(argv[1]) && realpathSync(argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const phase = argv[2];
  if (phase !== "init" && phase !== "finalize") {
    console.error("Usage : node scripts/version-manifest.mjs <init|finalize>");
    process.exit(1);
  }
  const manifest = phase === "init" ? initManifest(process.cwd()) : finalizeManifest(process.cwd());
  console.log(`version.json [${manifest.phase}] : version=${manifest.version}`);
}

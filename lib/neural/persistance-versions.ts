/**
 * PERSISTANCE VERSIONNÉE DES PARAMÈTRES APPRIS (mission « TERMINAL
 * COMPLETION » — exigence : « All learned parameters must be persistent
 * and versioned »).
 *
 * Le cerveau persiste déjà (persistance v1 brain-v1.json + rotation .bak,
 * artefact V2). Ce module ajoute la VERSIONNAGE : chaque événement
 * d'entraînement peut figer un SNAPSHOT réversible du cerveau avec un
 * MANIFESTE vérifiable (SHA-256 du fichier réel, taille, date, étiquette
 * et mesures d'entraînement) — et RESTAURER une version (rollback des
 * paramètres appris). Aucun paramètre appris n'est éphémère.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";

import { BRAIN_PATH } from "./training/persistence";

/** Racine des versions (au-dessus de var/neural/brain-v1.json). */
export function dossierVersions(): string {
  return join(process.cwd(), "var", "neural", "versions");
}

/** Manifeste d'une version (vérifiable par SHA-256). */
export interface ManifesteVersion {
  version: string;
  dateIso: string;
  etiquette: string;
  /** SHA-256 du fichier de cerveau versionné (vérifiable). */
  sha256: string;
  octets: number;
  /** Mesures d'entraînement associées (honnêtes, libres). */
  info: Record<string, unknown>;
}

/** SHA-256 d'un fichier réel. */
function sha256Fichier(chemin: string): string {
  return createHash("sha256").update(readFileSync(chemin)).digest("hex");
}

/** FIGE une version du cerveau (après sauvegarderCerveauRuntime()). */
export function sauvegarderVersion(
  etiquette: string,
  info: Record<string, unknown> = {},
  /** Racine injectable (tests) — défaut : var/neural/versions. */
  racineInjection?: string,
  /** Chemin du cerveau canonique injectable (tests) — défaut BRAIN_PATH. */
  cheminCerveau: string = BRAIN_PATH,
): ManifesteVersion {
  if (!existsSync(cheminCerveau)) {
    throw new Error("aucun cerveau persisté à versionner (sauvegarderCerveauRuntime d'abord)");
  }
  const horodatage = new Date().toISOString().replace(/[:.]/gu, "-");
  const version = `${horodatage}-${etiquette.replace(/[^a-z0-9-_]/giu, "-").slice(0, 60)}`;
  const dossier = join(racineInjection ?? dossierVersions(), version);
  mkdirSync(dossier, { recursive: true });
  const cible = join(dossier, basename(cheminCerveau));
  copyFileSync(cheminCerveau, cible);
  const manifeste: ManifesteVersion = {
    version,
    dateIso: new Date().toISOString(),
    etiquette,
    sha256: sha256Fichier(cible),
    octets: statSync(cible).size,
    info,
  };
  const tmp = join(dossier, "manifest.json.tmp");
  writeFileSync(tmp, JSON.stringify(manifeste, null, 1), "utf8");
  renameSync(tmp, join(dossier, "manifest.json"));
  return manifeste;
}

/** Liste les versions figées (la plus récente d'abord). */
export function listerVersions(racineInjection?: string): string[] {
  const racine = racineInjection ?? dossierVersions();
  if (!existsSync(racine)) return [];
  return readdirSync(racine)
    .filter((d) => existsSync(join(racine, d, "manifest.json")))
    .sort()
    .reverse();
}

/** Lit le manifeste d'une version (vérification par re-calcul du SHA-256). */
export function lireManifeste(version: string, racineInjection?: string): (ManifesteVersion & { integre: boolean }) | null {
  const racine = racineInjection ?? dossierVersions();
  const chemin = join(racine, version, "manifest.json");
  if (!existsSync(chemin)) return null;
  const manifeste = JSON.parse(readFileSync(chemin, "utf8")) as ManifesteVersion;
  const cerveau = join(racine, version, basename(BRAIN_PATH));
  const integre = existsSync(cerveau) && sha256Fichier(cerveau) === manifeste.sha256;
  return { ...manifeste, integre };
}

/** ROLLBACK : restaure une version figée vers le chemin canonique du cerveau. */
export function restaurerVersion(
  version: string,
  racineInjection?: string,
  cheminCerveau: string = BRAIN_PATH,
): boolean {
  const manifeste = lireManifeste(version, racineInjection);
  if (!manifeste || !manifeste.integre) return false;
  const source = join(racineInjection ?? dossierVersions(), version, basename(cheminCerveau));
  copyFileSync(source, cheminCerveau); // le .bak courant reste en place (garde v1)
  return true;
}

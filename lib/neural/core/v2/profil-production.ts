/**
 * PROFIL D'ÉNERGIE ACTIF — CANAL VERSIONNÉ (it.74, candidat №1 déclaré
 * it.73 §7.1 : « activer GEN3_PROFIL_ENERGIE=eco sur le VPS et mesurer
 * la réduction réelle de la charge serveur »).
 *
 * PROBLÈME : la variable d'environnement `GEN3_PROFIL_ENERGIE` vit dans
 * `.env.production` sur le VPS — fichier que le cd-finisher ne touchera
 * JAMAIS (garantie déploiement). Le dépôt ne peut donc pas activer le
 * profil éco par le canal PULL actuel. SOLUTION : un FICHIER VERSIONNÉ
 * dans le dépôt (`assets/config/profil-energie-production.json`) porte le
 * choix de sobriété — chaque activation est REVIEWÉE, historisée par git,
 * et déclarée publiquement (endpoint /api/energie + `raw.economieEnergie`
 * de chaque réponse). JAMAIS une économie silencieuse.
 *
 * PRIORITÉ (règle d'honnêteté it.73 conservée, conservatrice) :
 *   1. `GEN3_PROFIL_ENERGIE` défini et valide (« eco » / « telephone »)
 *      → il GAGNE (l'opérateur local reste maître) — source « env » ;
 *   2. `GEN3_PROFIL_ENERGIE` défini mais INCONNU → « plein » (comportement
 *      historique bit à bit — une valeur explicite inconnue ne doit
 *      JAMAIS retomber sur une économie non demandée) ;
 *   3. env absente → fichier versionné si lisible et valide
 *      — source « fichier-versionne » ;
 *   4. sinon (ou fichier absent/corrompu/inconnu) → « plein »
 *      — source « defaut-honnete ».
 *
 * PROTECTION TESTS : sous NODE_ENV === "test" (suite vitest), le fichier
 * versionné est IGNORÉ — la suite complète doit toujours exercer le
 * comportement historique bit à bit, indépendamment du choix de sobriété
 * de production. La garde 43ᵉ verrouille les deux branches.
 *
 * Module PUR côté logique (la lecture disque est isolée et injectable) —
 * aucune dépendance hors Node standard.
 */

import { readFileSync } from "node:fs";

import { VAR_ENV_PROFIL_ENERGIE, type ProfilEnergie } from "./energie";

/** Chemin du fichier versionné de choix de profil (relatif au cwd). */
export const CHEMIN_PROFIL_PRODUCTION =
  "assets/config/profil-energie-production.json";

/** D'où vient le profil actif (déclaré publiquement — /api/energie). */
export type SourceProfilEnergie =
  | "env"
  | "fichier-versionne"
  | "defaut-honnete";

/** Profil actif + sa source (tout est déclaré, jamais deviné en silence). */
export interface ProfilActif {
  readonly profil: ProfilEnergie;
  readonly source: SourceProfilEnergie;
}

/** Contenu attendu du fichier versionné (champs libres documentés). */
export interface ContenuFichierProfil {
  /** « eco » ou « telephone » — toute autre valeur → « plein ». */
  readonly profil?: unknown;
  /** Doit être true : le choix est une DÉCLARATION, pas un détour. */
  readonly declare?: unknown;
  /** Itération d'activation (traçabilité). */
  readonly it?: unknown;
  /** Date d'activation (ISO court). */
  readonly date?: unknown;
  /** Motif honnête (demande propriétaire, garde A/B…). */
  readonly motif?: unknown;
}

export interface OptionsProfilActif {
  /** Ignorer le fichier versionné (défaut : sous NODE_ENV=test). */
  readonly ignorerFichierVersionne?: boolean;
  /** Chemin du fichier (injection pour la garde — défaut réel). */
  readonly cheminFichier?: string;
  /** Lecteur disque injectable (défaut : readFileSync utf8). */
  readonly lire?: (chemin: string) => string;
}

/**
 * Lit le fichier versionné — null si absent, corrompu, non-objet (repli
 * honnête : jamais un profil déduit d'un fichier illisible).
 */
export function lireFichierProfilProduction(
  chemin: string = CHEMIN_PROFIL_PRODUCTION,
  lire: (chemin: string) => string = (c) => readFileSync(c, "utf8"),
): ContenuFichierProfil | null {
  try {
    const brut = lire(chemin);
    const parse = JSON.parse(brut) as unknown;
    if (typeof parse !== "object" || parse === null || Array.isArray(parse)) {
      return null;
    }
    return parse as ContenuFichierProfil;
  } catch {
    return null;
  }
}

/** Valeur de profil valide (« eco » / « telephone ») sinon undefined. */
function profilValide(brut: unknown): Exclude<ProfilEnergie, "plein"> | undefined {
  if (typeof brut !== "string") return undefined;
  const normalise = brut.trim().toLowerCase();
  if (normalise === "eco" || normalise === "telephone") return normalise;
  return undefined;
}

/**
 * Détermine le profil d'énergie ACTIF (cf. priorité en tête de fichier).
 * Sous NODE_ENV=test sans option explicite, le fichier versionné est
 * ignoré : la suite reste sur le comportement historique bit à bit.
 */
export function profilEnergieActif(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
  options: OptionsProfilActif = {},
): ProfilActif {
  const brutEnv = env[VAR_ENV_PROFIL_ENERGIE]?.trim().toLowerCase();
  if (brutEnv !== undefined) {
    // 1 & 2 — l'environnement local GAGNE quand il est valide ; une valeur
    // explicite inconnue retombe sur l'historique, JAMAIS sur une économie
    // non demandée (règle d'honnêteté it.73).
    const valide = profilValide(brutEnv);
    return valide
      ? { profil: valide, source: "env" }
      : { profil: "plein", source: "defaut-honnete" };
  }

  const ignorerFichier =
    options.ignorerFichierVersionne ?? process.env["NODE_ENV"] === "test";
  if (ignorerFichier) {
    return { profil: "plein", source: "defaut-honnete" };
  }

  // 3 — fichier versionné (le canal PULL livre ce choix avec le build).
  const fichier = lireFichierProfilProduction(
    options.cheminFichier ?? CHEMIN_PROFIL_PRODUCTION,
    options.lire,
  );
  const valideFichier = profilValide(fichier?.profil);
  if (valideFichier) {
    return { profil: valideFichier, source: "fichier-versionne" };
  }

  // 4 — repli honnête : comportement historique exact.
  return { profil: "plein", source: "defaut-honnete" };
}

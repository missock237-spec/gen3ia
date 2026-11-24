/**
 * PRIVACY FIREWALL (Lot 5 — Gen3ia Privacy Firewall, Phase 7 du plan).
 *
 * Règle 11 de la mission : « Interdire TECHNIQUEMENT l'utilisation des
 * données utilisateurs pour l'entraînement global. » La séparation n'est
 * PAS une instruction dans un prompt : c'est un garde de CHEMINS que tout
 * consommateur du pipeline d'apprentissage doit franchir.
 *
 * Espace AUTORISÉ pour le pipeline d'apprentissage global (connaissances
 * publiques autonomes) — relatif au dossier du core :
 *   acquisition/  — lots collectés (API publiques uniquement)
 *   pipeline/     — file persistante des lots
 *   connaissances/— mémoire permanente des connaissances vérifiées
 *
 * Espace INTERDIT (jamais lisible par le pipeline d'entraînement) :
 *   users/            — bases personnelles (user-data-store)
 *   mémoire personnelle, conversations, fichiers utilisateurs — tout autre
 *   chemin est REFUSÉ par défaut (liste blanche, pas liste noire).
 */

import { isAbsolute, join, normalize, resolve, sep } from "node:path";

/** Préfixes AUTORISÉS au pipeline d'apprentissage (liste blanche). */
export const PREFIXES_AUTORISES = ["acquisition/", "pipeline/", "connaissances/"] as const;

/** Préfixes utilisateur explicitement interdits (défense en profondeur). */
export const PREFIXES_UTILISATEURS = ["users/", "user/", "personal/", "private/"] as const;

/** Résultat honnête d'une vérification d'accès. */
export interface VerdictAcces {
  autorise: boolean;
  cheminNormalise: string;
  raison: string;
}

/**
 * VÉRIFIE qu'un chemin relatif au dossier du core est autorisé pour le
 * pipeline d'entraînement global. Anti-traversée : `..` et chemins
 * absolus sont normalisés puis re-vérifiés. Toute erreur est un refus.
 */
export function verifierAccesEntrainement(cheminRelatif: string, dossierCore: string): VerdictAcces {
  try {
    if (isAbsolute(cheminRelatif)) {
      return { autorise: false, cheminNormalise: cheminRelatif, raison: "chemin absolu refusé (liste blanche relative uniquement)" };
    }
    const normalise = normalize(cheminRelatif).split(sep).join("/");
    const resolu = resolve(join(dossierCore, normalise));
    const racineCore = resolve(dossierCore) + sep;
    if (!resolu.startsWith(racineCore)) {
      return { autorise: false, cheminNormalise: normalise, raison: "traversée hors du dossier du core refusée" };
    }
    for (const prefixe of PREFIXES_UTILISATEURS) {
      if (normalise.startsWith(prefixe)) {
        return { autorise: false, cheminNormalise: normalise, raison: `espace utilisateur (${prefixe}*) interdit au pipeline d'entraînement global — isolation technique` };
      }
    }
    const autorise = PREFIXES_AUTORISES.some((p) => normalise.startsWith(p));
    return {
      autorise,
      cheminNormalise: normalise,
      raison: autorise
        ? `chemin de connaissances publiques autorisé (${PREFIXES_AUTORISES.join(", ")})`
        : `chemin hors liste blanche (${PREFIXES_AUTORISES.join(", ")}) refusé par défaut`,
    };
  } catch (erreur) {
    return { autorise: false, cheminNormalise: String(cheminRelatif), raison: `vérification impossible → refus fail-closed : ${erreur instanceof Error ? erreur.message : String(erreur)}` };
  }
}

/** Ouvre (lit) un fichier du core UNIQUEMENT s'il est dans l'espace autorisé. */
export function lireSiAutorise(
  cheminRelatif: string,
  dossierCore: string,
  lire: (cheminAbsolu: string) => string,
): { autorise: boolean; contenu?: string; raison: string } {
  const verdict = verifierAccesEntrainement(cheminRelatif, dossierCore);
  if (!verdict.autorise) {
    return { autorise: false, raison: verdict.raison };
  }
  try {
    return { autorise: true, contenu: lire(join(dossierCore, verdict.cheminNormalise)), raison: verdict.raison };
  } catch (erreur) {
    return { autorise: true, raison: `lecture échouée (non-fatale) : ${erreur instanceof Error ? erreur.message : String(erreur)}` };
  }
}

/**
 * Audit de cohérence du firewall : la liste blanche ne contient-elle
 * AUCUN préfixe utilisateur ? (garde structurel — appelable en test et au
 * démarrage du worker.)
 */
export function isolationCoherente(): boolean {
  return PREFIXES_AUTORISES.every(
    (p) => !PREFIXES_UTILISATEURS.some((u) => p.startsWith(u) || u.startsWith(p)),
  );
}

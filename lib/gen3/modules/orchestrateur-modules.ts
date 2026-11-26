/**
 * ORCHESTRATEUR DES 12 MODULES GEN3 — routage déterministe des demandes vers
 * les modules compétents (demande propriétaire : « 12 modules orchestrés par
 * Gen3 Core, chaque demande analysée puis dirigée vers les bons modules »).
 *
 * PRINCIPES (alignés sur la culture du dépôt) :
 *  - DÉTERMINISTE : même demande → même routage (aucun aléa, aucun LLM
 *    externe — score lexical normalisé, même règle que le corpus :
 *    minuscules sans accents) ;
 *  - TRAÇABLE : chaque rapport porte les scores par module, le module
 *    principal, les modules secondaires et la latence réelle de décision ;
 *  - HONNÊTE : sous un seuil de score minimal, le rapport déclare
 *    `decide: false` et retombe sur Core (aucun module fantôme activé) ;
 *  - SANS EFFET DE BORD : le routage DÉCIDE — il n'exécute rien par
 *    lui-même. L'exécution reste dans les organes réels déclarés par chaque
 *    module (engine, media-service, pipeline vidéo, sandbox…) appelés par
 *    les chemins existants (chat, API, automatisations).
 *
 * MODULE PUR — partageable serveur et tests sans IO (la santé disque des
 * organes est fournie par inventaireModulesGen3 côté API uniquement).
 */

import {
  MODULES_GEN3,
  NB_MODULES_GEN3,
  type IdModuleGen3,
  type ModuleGen3,
} from "./modules-gen3";

/** Normalisation identique au corpus/vocation : minuscules, sans accents,
 * espaces collapsés — les signaux des modules suivent la même règle. */
function normaliser(texte: string): string {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Un score de routage par module. */
export interface ScoreModule {
  readonly id: IdModuleGen3;
  readonly label: string;
  readonly niveau: ModuleGen3["niveau"];
  /** Nombre de signaux distincts trouvés dans la demande. */
  readonly signauxTrouves: readonly string[];
  /** Score brut = signaux distincts × longueur du signal le plus long
   *  (un signal long et spécifique pèse plus qu'un signal court). */
  readonly score: number;
}

/** Rapport de routage d'une demande vers les 12 modules. */
export interface RapportRoutage {
  /** La demande normalisée (tronquée à 200 caractères pour les journaux). */
  readonly demande: string;
  /** Module principal décidé (le mieux classé au-dessus du seuil), sinon
   *  "core" avec decide=false. */
  readonly modulePrincipal: IdModuleGen3;
  /** Modules secondaires pertinents (score > 0, ordre décroissant, hors
   *  principal, plafonné à 3). */
  readonly modulesSecondaires: readonly IdModuleGen3[];
  /** Un module principal a-t-il dépassé le seuil de décision ? */
  readonly decide: boolean;
  /** Scores détaillés par module (ordre canonique des 12 modules). */
  readonly scores: readonly ScoreModule[];
  /** Latence réelle de la décision en millisecondes (performance.now). */
  readonly latenceMs: number;
}

/** Seuil minimal de score pour activer un module principal. Sous ce seuil,
 *  le routage retombe sur Core avec `decide: false` (honnêteté). */
export const SEUIL_DECISION_MODULE = 4;

/** Score maximal de modules secondaires rapportés. */
export const MAX_SECONDAIRES = 3;

/** Calcule le score d'un module pour une demande normalisée. */
function scorerModule(module: ModuleGen3, demande: string): ScoreModule {
  const trouves: string[] = [];
  for (const signal of module.signaux) {
    if (demande.includes(signal)) trouves.push(signal);
  }
  const plusLong = trouves.reduce((max, s) => Math.max(max, s.length), 0);
  return {
    id: module.id,
    label: module.label,
    niveau: module.niveau,
    signauxTrouves: trouves,
    score: trouves.length * plusLong,
  };
}

/** ROUTAGE PRINCIPAL : décide quels modules une demande active.
 *  Déterministe : aucune IO, aucune horloge murale — la latence est mesurée
 *  avec performance.now() (monotone). */
export function routerVersModules(demande: string): RapportRoutage {
  const debut = performance.now();
  const normalisee = normaliser(demande);
  const tronquee = normalisee.slice(0, 200);

  const scores = MODULES_GEN3.map((m) => scorerModule(m, normalisee));
  const classes = [...scores].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const meilleur = classes[0];
  const decide = meilleur.score >= SEUIL_DECISION_MODULE;
  const modulePrincipal = decide ? meilleur.id : "core";
  const modulesSecondaires = classes
    .filter((s) => s.score > 0 && s.id !== modulePrincipal)
    .slice(0, MAX_SECONDAIRES)
    .map((s) => s.id);

  return {
    demande: tronquee,
    modulePrincipal,
    modulesSecondaires,
    decide,
    scores,
    latenceMs: Math.round((performance.now() - debut) * 1000) / 1000,
  };
}

/** Inventaire pour l'API / tableau de bord : les 12 modules enrichis d'un
 *  état de santé d'organes CALCULÉ PAR L'APPELANT (la fonction ne touche
 *  pas au disque — pur). `organesAbsents` est la liste des chemins que
 *  l'appelant (route API, serveur) a trouvés absents via fs.existsSync. */
export function inventaireModulesGen3(
  organesAbsents: readonly string[] = [],
): Array<ModuleGen3 & { organesVerifies: number; organesAbsents: readonly string[] }> {
  const absents = new Set(organesAbsents);
  return MODULES_GEN3.map((m) => {
    const manquants = m.organes.filter((chemin) => absents.has(chemin));
    return {
      ...m,
      organesVerifies: m.organes.length - manquants.length,
      organesAbsents: manquants,
    };
  });
}

/** Re-export pratique pour les API : nombre de modules. */
export { NB_MODULES_GEN3, MODULES_GEN3 };

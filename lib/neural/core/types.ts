/**
 * TYPES DU SYSTÈME NEURONAL GEN3 (portage TypeScript fidèle de la source Python).
 *
 * Source de vérité : scripts/neural_reference/core_reference.py et
 * effectors_reference.py (code exact de l'utilisateur). Ce fichier centralise
 * les contrats types partagés par le noyau (core/), le corps sémantique
 * (effectors/), l'encodage (encoding/) et le décodage (decoding/).
 *
 * Module PUR : aucune dépendance Node ni `server-only` — testable partout.
 */

/**
 * Configuration de construction du réseau neuronal.
 * Les valeurs par défaut reprennent exactement celles de la source Python
 * (taille 100, densité 0.1, taux d'apprentissage 0.05, seuil 1.0, décroissance
 * 0.1, fenêtre de plasticité 2.0) ; `seed` est l'adaptation (a) : RNG déterministe
 * seedé pour des exécutions reproductibles (la source utilisait `random` global).
 */
export interface NeuralConfig {
  /** Nombre de neurones du réseau (IDs 0..size-1). */
  size: number;
  /** Probabilité d'une connexion src→tgt lors de la génération initiale. */
  density: number;
  /** Renforcement synaptique par pas de temps (plasticité non supervisée). */
  learningRate: number;
  /** Seuil de déclenchement (spike) par défaut d'un neurone. */
  defaultThreshold: number;
  /** Perte naturelle d'énergie par pas de temps (décroissance). */
  defaultDecay: number;
  /** Fenêtre de plasticité : renforcement si la cible a spike récemment. */
  plasticityWindow: number;
  /** Graine du générateur aléatoire déterministe (adaptation (a)). */
  seed: number;
}

/** Valeurs par défaut, fidèles à la source Python. */
export const NEURAL_CONFIG_DEFAUTS: NeuralConfig = {
  size: 100,
  density: 0.1,
  learningRate: 0.05,
  defaultThreshold: 1.0,
  defaultDecay: 0.1,
  plasticityWindow: 2.0,
  seed: 42,
};

/**
 * Métriques de santé du noyau central — mêmes clés que la source Python
 * (`metriques_sante`), en camelCase TypeScript.
 */
export interface HealthMetrics {
  /** Nombre total de cycles exécutés depuis la création du noyau. */
  cyclesTotaux: number;
  /** Énergie moyenne des neurones au dernier contrôle de santé. */
  energieMoyenne: number;
  /** Indice d'homéostasie : 1.0 équilibre, 0.75 surcharge, 0.90 relance. */
  indiceHomeostasie: number;
  /** Mode courant du noyau (VEILLE, TRAITEMENT_REQUETE, AUTO_OSCILLATION_VEILLE). */
  modeActuel: string;
}

/**
 * Statut d'une action du corps sémantique.
 *
 * `MOTEUR_EXTERNE_DESACTIVE` : adaptation honnête du portage — les générateurs
 * média (audio/image/vidéo) et la téléphonie s'appuient sur des moteurs de
 * rendu externes volontairement NON connectés en mode neuronal (test SNN).
 * Leurs actions internes le déclarent explicitement au lieu de simuler des
 * fichiers/scores : la mécanique (résonance, sandbox, métriques d'usage) reste
 * 100 % réelle, seule la sortie de rendu est absente.
 */
export type EffectorStatus =
  | "SUCCES"
  | "ECHEC"
  | "INCONNU"
  | "MOTEUR_EXTERNE_DESACTIVE"
  | "MOTEUR_LOCAL_INDISPONIBLE";

/**
 * Résultat d'une action déclenchée par un effecteur du corps sémantique.
 * L'index signature autorise les champs additionnels propres à chaque
 * effecteur (outil, resultat, dureeMs, transcription...) comme en Python.
 */
export interface EffectorActionResult {
  /** Type d'action / canal d'origine (ex : "GENERER_AUDIO", "EXECUTER_OUTIL_OS"). */
  type: string;
  /** Statut homogène de l'action (adaptation typée du portage). */
  status: EffectorStatus;
  /** Détail lisible, optionnel. */
  details?: string;
  /** Champs additionnels propres à l'effecteur. */
  [champ: string]: unknown;
}

/**
 * Contrat d'un effecteur du corps sémantique : il « écoute » le noyau à chaque
 * cycle et n'agit que si la résonance de son pool de sortie franchit le seuil.
 */
export interface Effecteur {
  /** Nom lisible de l'effecteur (diagnostique, logs). */
  readonly nom: string;
  /**
   * Évalue la résonance du cycle et exécute les actions déclenchées.
   * @param spikedNeurones IDs des neurones ayant spike ce cycle.
   * @param contexte Contexte optionnel (commande d'outil, paramètres média...).
   * @returns Les actions réellement exécutées (vide si aucune résonance).
   */
  evaluerEtExecuter(
    spikedNeurones: number[],
    contexte?: Record<string, unknown>,
  ): EffectorActionResult[];
}

/**
 * Rapport d'un cycle complet du noyau central.
 * Reprise typée du dictionnaire Python, enrichie de la liste exacte des
 * neurones spike (`spikedNeurones`) nécessaire au décodage côté moteur.
 */
export interface CycleReport {
  /** Numéro du cycle (1-based, compteur cumulé). */
  cycle: number;
  /** Mode du cycle : "TRAITEMENT_REQUETE" ou "AUTO_OSCILLATION_VEILLE". */
  mode: string;
  /** IDs exacts des neurones ayant spike pendant ce cycle. */
  spikedNeurones: number[];
  /** Nombre de neurones actifs (longueur de `spikedNeurones`). */
  neuronesActifs: number;
  /** Instantané des métriques de santé après homéostasie. */
  sante: HealthMetrics;
  /** Actions réellement déclenchées par le corps sémantique. */
  actionsCorps: EffectorActionResult[];
}

/** Constructeur d'un résultat d'action avec champs additionnels libres. */
export function actionEffecteur(
  type: string,
  status: EffectorStatus,
  champs: Record<string, unknown> = {},
): EffectorActionResult {
  const action: EffectorActionResult = { type, status };
  for (const [cle, valeur] of Object.entries(champs)) {
    // `type` et `status` ne sont jamais écrasés par des champs additionnels.
    if (cle === "type" || cle === "status") continue;
    if (cle === "details") {
      if (typeof valeur === "string") action.details = valeur;
      continue;
    }
    // L'index signature [cle: string]: unknown autorise l'assignation.
    action[cle] = valeur;
  }
  return action;
}

/* ============================================================================
 * ALLOCATION NEURONALE (fidèle à la source utilisateur)
 *
 * Le réseau de 100 neurones est découpé en zones fonctionnelles. Chaque pool
 * de 2 neurones correspond à une intention/action du corps sémantique : la
 * résonance du pool (fraction de neurones ayant spike) pilote le déclenchement.
 * ==========================================================================*/

/** Zone 0..37 : hachage des tokens d'entrée (38 neurones, voir encoding/). */
export const ZONE_TOKENS = { debut: 0, fin: 37, taille: 38 } as const;

/** Pool d'entrée principal (canal sémantique « utilisateur_in »). */
export const POOL_UTILISATEUR_IN: readonly number[] = [38, 39];

/** Pool de sortie : génération audio (effecteurs/audio.ts). */
export const POOL_GENERER_AUDIO: readonly number[] = [42, 43];

/** Pool de sortie : génération vidéo (effectors/video.ts). */
export const POOL_GENERER_VIDEO: readonly number[] = [44, 45];

/** Pool de sortie : génération d'images (effectors/visual.ts). */
export const POOL_GENERER_IMAGE: readonly number[] = [46, 47];

/** Pool de sortie : exécution d'outils OS (effectors/tool-os.ts). */
export const POOL_EXECUTER_OUTIL_OS: readonly number[] = [48, 49];

/** Pool de sortie : cartographie des compétences (effectors/skills-engine.ts). */
export const POOL_CARTOGRAPHIER_COMPETENCES: readonly number[] = [50, 51];

/** Pool de sortie : sélection + exécution d'une compétence (skills-engine). */
export const POOL_SELECTIONNER_ET_EXECUTER_SKILL: readonly number[] = [52, 53];

/** Pool de sortie : évaluation de performance d'une compétence (skills-engine). */
export const POOL_EVALUER_PERFORMANCE_SKILL: readonly number[] = [54, 55];

/** Pool de sortie : initier un appel téléphonique (effectors/voice-phone.ts). */
export const POOL_INITIALISER_APPEL: readonly number[] = [60, 61];

/** Pool de sortie : écouter le flux audio entrant (voice-phone). */
export const POOL_ECOUTER_AUDIO: readonly number[] = [62, 63];

/** Pool de sortie : émettre une réponse vocale (voice-phone). */
export const POOL_EMETTRE_REPONSE_VOCALE: readonly number[] = [64, 65];

/** Pool de sortie : terminer l'appel en cours (voice-phone). */
export const POOL_TERMINER_APPEL: readonly number[] = [66, 67];

/**
 * Pool d'intention générale conversationnelle (ajout du portage, activé par le
 * runtime) : réponse par défaut quand aucune intention spécifique ne résonne.
 */
export const POOL_INTENTION_GENERALE: readonly number[] = [68, 69];

/**
 * Pool réservé « system_action » — exemple de la source Python
 * (Espace d'entrée-sortie, `output_pools`), conservé sans effecteur dédié.
 */
export const POOL_SYSTEM_ACTION: readonly number[] = [96, 97, 98, 99];

/** Neurones libres (interneurones) : 40-41, 56-59, 70-95. */
export const NEURONES_LIBRES: readonly number[] = [
  40, 41, 56, 57, 58, 59,
  ...Array.from({ length: 26 }, (_, i) => 70 + i), // 70..95
];

/** Nom canonique du canal d'entrée utilisateur. */
export const CANAL_UTILISATEUR_IN = "utilisateur_in";

/** Nom canonique du pool d'intention générale. */
export const CANAL_INTENTION_GENERALE = "INTENTION_GENERALE";

/** Nom canonique du pool réservé (exemple de la source). */
export const CANAL_SYSTEM_ACTION = "SYSTEM_ACTION";

/**
 * Étiquette d'intention par défaut du décodeur et de l'entraînement.
 * (Le nom court « INTENTION_GENERALE » identifie le pool 68-69.)
 */
export const INTENTION_GENERALE = "INTENTION_GENERALE";

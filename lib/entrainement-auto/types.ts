import "server-only";

/**
 * TYPES DE L'AUTO-APPRENTISSAGE — Gen3ia s'entraîne SEULE dès son lancement.
 *
 * Au démarrage du serveur (instrumentation.ts → register()), une boucle
 * autonome interroge les HUBS DE DATASETS configurés dans l'ancien env —
 * Hugging Face (HF_TOKEN optionnel) et Kaggle (KAGGLE_API_TOKEN) — choisit
 * des jeux de données pertinents, les télécharge dans des plafonds stricts,
 * les convertit en matière d'entraînement (paires conversationnelles pour le
 * cortex langagier, échantillons étiquetés pour la plasticité supervisée du
 * SNN) puis applique l'entraînement RÉEL au runtime neuronal.
 *
 * HONNÊTETÉ (règle du projet) : chaque rapport reflète ce qui s'est réellement
 * passé — sans jeton Kaggle, Kaggle est « non configuré » et ignoré ; sans
 * réseau, le cycle échoue avec un message lisible ; aucune métrique n'est
 * simulée.
 */

/** Sources de données connectées (connecteurs réels de lib/training/hub). */
export type HubSource = "huggingface" | "kaggle";

/**
 * LES DEUX PHASES DE VIE DE L'IA :
 *  - « absorption » : fenêtre BORNÉE au lancement (défaut 2 h) — Gen3ia se
 *    connecte à ses hubs (Hugging Face + Kaggle) et prend TOUT ce qu'elle
 *    peut de ses datasets dans cette fenêtre ;
 *  - « autonomie » : la fenêtre est clôturée DÉFINITIVEMENT (état persisté)
 *    — les hubs ne sont plus jamais interrogés ; l'IA s'appuie sur ce qu'elle
 *    a absorbé et son évolution continue passe UNIQUEMENT par ses
 *    utilisateurs (consolidation des échanges réels, lib/neural/evolution.ts).
 */
export type PhaseVie = "absorption" | "autonomie";

/**
 * Objectifs d'entraînement alimentés par les datasets :
 *  - « langage »   : paires { motif, réponse } → cortex langagier Gen3 ;
 *  - « intention » : échantillons { text, label } → entraîneur supervisé SNN.
 */
export type ObjectifAuto = "langage" | "intention";

/** Jeu de données retenu par le conservateur pour un cycle. */
export interface DatasetChoisi {
  provider: HubSource;
  /** Référence hub « propriétaire/jeu-de-données ». */
  ref: string;
  titre: string;
  objectif: ObjectifAuto;
}

/** Bilan par hub d'un cycle (compteurs réels + erreurs lisibles). */
export interface RapportHubCycle {
  provider: HubSource;
  /** Faux = hub ignoré (jeton absent) — signalé tel quel, jamais masqué. */
  configure: boolean;
  datasetsConsiderees: number;
  datasetsIngestes: number;
  paires: number;
  echantillons: number;
  erreurs: string[];
}

/** Résultat de l'apprentissage langagier (stats réelles du cortex). */
export interface RapportLangageCycle {
  pairesAjoutees: number;
  doublons: number;
  vocabulaire: number;
}

/** Résultat de l'entraînement supervisé d'intentions (métriques réelles). */
export interface RapportIntentionCycle {
  echantillons: number;
  epoques: number;
  accuracyTrain: number;
  accuracyTest: number;
  dureeMs: number;
}

/** Rapport complet d'un cycle d'auto-apprentissage. */
export interface RapportCycleAuto {
  v: 1;
  id: string;
  demarreA: string;
  dureeMs: number;
  /** « termine » : datasets ingérés + entraînement appliqué ; « partiel » :
   *  données ingérées mais entraînement non appliqué ; « echec » : rien
   *  d'ingéré (message explicite) ; « refuse » : phase autonomie — les hubs
   *  sont coupés, aucun accès réseau, aucun entraînement depuis datasets. */
  statut: "termine" | "partiel" | "echec" | "refuse";
  message: string;
  hubs: RapportHubCycle[];
  langage?: RapportLangageCycle;
  intention?: RapportIntentionCycle;
  /** Références réellement ingérées ce cycle. */
  datasetsIngestes: string[];
}

/**
 * BILAN D'AUTONOMIE — écrit UNE fois, à la clôture de la fenêtre d'absorption.
 * C'est la réponse honnête à « l'IA doit savoir tout ce dont elle a besoin
 * pour son évolution » : ce qu'elle a réellement absorbé, et les axes
 * déterministes (dérivés des métriques réelles, jamais inventés) qui
 * guident son évolution par les utilisateurs.
 */
export interface BilanAutonomie {
  /** Date ISO de la clôture de la fenêtre d'absorption. */
  clotureA: string;
  /** Durée réellement utilisée de la fenêtre (ms). */
  dureeUtiliseeMs: number;
  /** Cumuls réels absorbés pendant la fenêtre (tous cycles confondus). */
  pairesAbsorbees: number;
  echantillonsAbsorbes: number;
  datasetsAbsorbes: number;
  /** Axes d'évolution dérivés des métriques réelles (ordre stable). */
  axes: string[];
  /** Phrase honnête de clôture (affichée telle quelle). */
  message: string;
}

/** État persistant de l'auto-apprentissage (var/entrainement-auto/etat.json). */
export interface EtatAutoApprentissage {
  /** v2 : cycle de vie absorption → autonomie (migration v1 automatique). */
  v: 2;
  /** Date ISO d'initialisation de l'état (premier lancement constaté) —
   *  origine de la fenêtre d'absorption (jamais réinitialisée au reboot). */
  lanceA: string;
  /** Cycles exécutés (termine, partiel ET echec — un cycle raté reste un cycle). */
  cyclesExecutes: number;
  enCours: boolean;
  dernierRapport: RapportCycleAuto | null;
  /** 10 derniers rapports (les plus récents d'abord). */
  historique: RapportCycleAuto[];
  /** Références déjà ingérées (anti-rejoue, plafonné). */
  datasetsIngestes: string[];
  pairesCumulees: number;
  echantillonsCumules: number;
  /** Fenêtre d'absorption clôturée ? Une fois true, les hubs ne sont plus
   *  JAMAIS interrogés (persisté — survit aux redémarrages). */
  absorptionCloturee: boolean;
  /** Date ISO de la clôture (null tant que la fenêtre est ouverte). */
  absorptionClotureeA: string | null;
  /** Bilan d'autonomie écrit à la clôture (null avant). */
  bilanAutonomie: BilanAutonomie | null;
}

/**
 * Contrat hub injectable — l'adaptateur réel enrobe la façade
 * lib/training/hub ; les tests fournissent un client factice déterministe.
 * Minimale volontairement : aucune dépendance aux schémas zod du hub.
 */
export interface ClientHubAuto {
  /** Recherche paginée sur le hub (tri téléchargements). */
  rechercher(
    provider: HubSource,
    requete: string,
    limite: number,
  ): Promise<Array<{ ref: string; titre: string; downloads: number | null; taille: number | null }>>;
  /** Inspection : liste des fichiers ingérables du dataset. */
  inspecter(
    provider: HubSource,
    ref: string,
  ): Promise<{ files: Array<{ name: string; sizeBytes: number; downloadable: boolean }> }>;
  /** Téléchargement plafonné (le plafond est appliqué côté connecteur). */
  telecharger(provider: HubSource, ref: string, fichier: string, maxOctets: number): Promise<Buffer>;
  /** Configuration honnête du connecteur (jeton présent ?). */
  estConfigure(provider: HubSource): boolean;
}

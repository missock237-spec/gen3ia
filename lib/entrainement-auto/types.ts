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
 * LES TROIS PHASES DE VIE DE L'IA :
 *  - « absorption » : fenêtre BORNÉE au lancement (défaut 2 h) — Gen3ia se
 *    connecte à ses hubs (Hugging Face + Kaggle) et prend TOUT ce qu'elle
 *    peut de ses datasets dans cette fenêtre ;
 *  - « autonomie » : la fenêtre est clôturée DÉFINITIVEMENT (état persisté)
 *    — les hubs ne sont plus jamais interrogés ; l'IA s'appuie sur ce qu'elle
 *    a absorbé et son évolution continue passe UNIQUEMENT par ses
 *    utilisateurs (consolidation des échanges réels, lib/neural/evolution.ts) ;
 *  - « maîtrise » : RÉGIME CONTINU (directive propriétaire — entraînement
 *    autonome à grande échelle) — les hubs restent ouverts cycle après
 *    cycle, domaine après domaine, JUSQU'À la maîtrise mesurée du catalogue
 *    complet (voir maitrise.ts). La boucle ne s'arrête qu'à maîtrise
 *    totale — jamais avant, jamais sans mesure réelle.
 */
export type PhaseVie = "absorption" | "autonomie" | "maitrise";

/** Régime de vie persisté (v3) — « maitrise » par défaut (directive). */
export type RegimeAuto = "fenetre" | "maitrise";

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
  /** Domaine du catalogue de maîtrise (régime maîtrise seulement). */
  domaineId?: string;
}

/* ------------------------------------------------------------------ */
/* MAÎTRISE — registre des domaines (régime continu v3)                 */
/* ------------------------------------------------------------------ */

/** Une évaluation de maîtrise (métrique RÉELLE mesurée sur données tenues
 *  à l'écart de l'entraînement — jamais une estimation). */
export interface EvaluationMaitrise {
  /** Date ISO de l'évaluation. */
  dateA: string;
  /** Précision mesurée (0..1) : rétention cortex (langage) ou accuracyTest
   *  du SNN sur jeu tenu à l'écart (intention). */
  accuracy: number;
  /** Nombre d'unités de validation réellement évaluées. */
  unites: number;
  /** false = évaluation consignée mais NON comptable (trop peu d'unités
   *  pour être statistiquement porteuse — honnêteté avant optimisme). */
  valide: boolean;
}

/** État de maîtrise d'UN domaine du catalogue. */
export interface EtatDomaineMaitrise {
  /** Références hub ingérées pour ce domaine (anti-rejoue par domaine). */
  datasetsIngerees: string[];
  /** Paires conversationnelles ingérées (objectif langage). */
  pairesIngestees: number;
  /** Échantillons étiquetés ingérés (objectif intention). */
  echantillonsIngestes: number;
  /** 10 dernières évaluations (les plus récentes d'abord). */
  dernieresEvaluations: EvaluationMaitrise[];
  /** Passes consécutifs (accuracy ≥ seuil ET évaluation valide). */
  passesConsicutifs: number;
  /** Date ISO où le domaine a été déclaré maîtrisé (null sinon). */
  maitriseA: string | null;
}

/** Bloc de maîtrise persisté (état v3). */
export interface BlocMaitrise {
  /** Version du catalogue — un changement de catalogue incrémente ce numéro. */
  catalogueVersion: 1;
  /** État par domaine, clé = identifiant du domaine du catalogue. */
  domaines: Record<string, EtatDomaineMaitrise>;
  /** Date ISO où le catalogue COMPLET a été maîtrisé (null = boucle active). */
  atteinteA: string | null;
  /** Nombre total d'évaluations exécutées (tous domaines). */
  evaluationsTotales: number;
  /** Cycles consécutifs sans aucun progrès (backoff anti-boucle-crashee). */
  cyclesSansProgres: number;
}

/** Bloc maîtrise d'un rapport de cycle (régime maîtrise). */
export interface RapportMaitrise {
  regime: "maitrise";
  /** Domaine entraîné ce cycle. */
  domaineCible: string;
  domaineLabel: string;
  objectif: ObjectifAuto;
  /** Au moins un dataset ingéré ce cycle pour ce domaine ? */
  ingereCeCycle: boolean;
  /** Évaluation de maîtrise exécutée ce cycle (si assez de matière). */
  evaluation?: { accuracy: number; unites: number; valide: boolean; seuil: number };
  /** Le domaine est devenu maîtrisé À CE cycle. */
  maitriseCeDomaine: boolean;
  /** TOUS les domaines du catalogue sont maîtrisés — la boucle s'arrête. */
  complete: boolean;
  domainesMaitrises: number;
  domainesTotal: number;
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
  /** Présent en régime maîtrise : progression du catalogue. */
  maitrise?: RapportMaitrise;
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
  /** v3 : régime de vie persisté (« maitrise » par défaut — directive
   *  propriétaire : entraînement autonome continu jusqu'à maîtrise totale
   *  du catalogue HF + Kaggle) + bloc de maîtrise par domaine. Les
   *  migrations v1→v3 et v2→v3 sont automatiques et sans perte. */
  v: 3;
  /** Régime de vie courant. « fenetre » = cycle de vie historique (absorption
   *  bornée → autonomie définitive). « maitrise » = hubs ouverts jusqu'à
   *  maîtrise complète du catalogue (maitrise.ts). */
  regime: RegimeAuto;
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
  /** v3 : registre de maîtrise du catalogue (régime « maitrise »). */
  maitrise: BlocMaitrise;
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
  /** OPTIONNEL — lignes réelles via l'API de paging du hub (datasets-server
   *  /rows pour Hugging Face : ouvre les datasets parquet-only sans
   *  télécharger de fichier). Absent chez les clients de test simples ;
   *  l'ingesteur le traite comme un enrichissement, jamais une exigence. */
  lireLignes?(provider: HubSource, ref: string, maxLignes: number): Promise<Array<Record<string, unknown>>>;
}

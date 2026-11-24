/**
 * CONTRATS DU GEN3IA AUTONOMOUS CORE (Phase 1 du plan directeur
 * « GEN3IA AUTONOMOUS BRAIN »).
 *
 * Principe directeur du plan : chaque module est un AGENT connecté à gen3,
 * qui exécute sa tâche de manière AUTONOME et CONTINUE. Le core les arme,
 * les supervise et les relance — il ne fait JAMAIS leur travail à leur place.
 *
 * Contraintes non négociables du plan (Lot 1) :
 *  - une panne d'un module ne bloque JAMAIS les autres (isolation par tick) ;
 *  - les opérations interrompues peuvent reprendre (état persisté) ;
 *  - les tâches restent traçables (identifiant unique + historique) ;
 *  - les cycles ne dépendent pas du traitement des cycles précédents.
 */

/** Statuts d'une tâche traçable du core. */
export type StatutTache =
  | "EN_ATTENTE"
  | "EN_COURS"
  | "TERMINEE"
  | "ECHEC"
  | "REPRISE";

/** Priorité d'une tâche (les plus petites valeurs s'exécutent d'abord). */
export type PrioriteTache = "critique" | "normale" | "basse";

/**
 * Surface du gestionnaire de tâches utilisée par les modules-agents (le
 * contrat évite la circularité d'import avec l'implémentation concrète,
 * qui la satisfait structurellement).
 */
export interface GestionTaches {
  creer(options: {
    module: string;
    cycle: number;
    type: string;
    priorite?: PrioriteTache;
    idExistant?: string;
  }): Tache | null;
  demarrer(id: string, details?: string): boolean;
  terminer(id: string, details?: string): boolean;
  echouer(id: string, details?: string): boolean;
  obtenir(id: string): Tache | null;
}

/** Événement d'historique d'une tâche (traçabilité 100 %). */
export interface EvenementTache {
  dateIso: string;
  evenement: string;
  details?: string;
}

/** Tâche traçable du core (identifiant unique, cycle, historique complet). */
export interface Tache {
  /** Identifiant unique — T-<cycle>-<8 hex> (idempotence). */
  id: string;
  /** Module-agent propriétaire de la tâche. */
  module: string;
  /** Cycle du core qui a créé la tâche. */
  cycle: number;
  /** Type de tâche (libre, ex. "collecte", "entraînement", "sante"). */
  type: string;
  statut: StatutTache;
  priorite: PrioriteTache;
  creeLe: string;
  majLe: string;
  /** Historique borné (20 derniers événements) — jamais tronqué en secret. */
  historique: EvenementTache[];
}

/** Rapport honnête d'un tick de module-agent. */
export interface RapportModule {
  /** succes (travail fait) | echec | rien_a_faire (cycle sans travail dû). */
  statut: "succes" | "echec" | "rien_a_faire";
  /** Message lisible (jamais inventé — cf. conventions honnêtes du dépôt). */
  message: string;
  /** Identifiants des tâches créées/traitées durant le tick (traçabilité). */
  taches?: string[];
  /** Détails libres (mesures réelles uniquement). */
  details?: Record<string, unknown>;
}

/** Contexte remis à chaque tick de module-agent. */
export interface ContexteTick {
  /** Numéro du cycle du core (monotone, commence à 1). */
  cycle: number;
  /** Date ISO du tick. */
  dateIso: string;
  /** Gestionnaire de tâches du core (traçabilité). */
  taches: GestionTaches;
  /**
   * Bus d'événements inter-modules : les événements émis ici sont remis aux
   * autres modules à LEUR prochain tick (communication sans blocage). Le
   * dateIso d'émission est posé par le core (la charge utile du module reste
   * minimale).
   */
  emettreEvenement(evenement: Omit<EvenementModule, "dateIso"> & { dateIso?: string }): void;
  /** Événements reçus depuis le dernier tick de CE module. */
  evenementsRecus: EvenementModule[];
}

/** Événement inter-modules (les modules communiquent sans s'attendre). */
export interface EvenementModule {
  /** Module émetteur. */
  de: string;
  /** Sujet court (ex. "nouvelle-connaissance", "cerveau-sauvegarde"). */
  sujet: string;
  /** Charge utile bornée (les gros contenus passent par les tâches). */
  charge?: Record<string, unknown>;
  /** Date ISO d'émission. */
  dateIso: string;
}

/**
 * CONTRAT D'UN MODULE-AGENT — chaque phase du plan s'ajoute au core en
 * implémentant cette interface (collecteur, file, intelligence, mémoire…).
 */
export interface ModuleAgent {
  /** Identifiant stable (ex. "acquisition", "sante-cerveau"). */
  id: string;
  /** Nom lisible. */
  nom: string;
  /** Rôle dans l'architecture cible (ex. "01. DATA ACQUISITION"). */
  role: string;
  /**
   * Intervalle minima entre deux ticks (ms). Défaut : le cycle de base du
   * core (5 min). Un module peut être plus lent — jamais plus rapide que le
   * cycle de base (le scheduler ne redescend pas sous 60 s).
   */
  intervalleMs?: number;
  /**
   * UN tick du module : le travail réel borné. Contrat : ne JAMAIS lever
   * (retourner statut "echec" + message honnête) ; retourner vite (le
   * process-manager applique un timeout de sécurité) ; créer/terminer ses
   * tâches via ctx.taches pour la traçabilité.
   */
  tick(ctx: ContexteTick): Promise<RapportModule>;
}

/** État d'un module-agent supervisé par le core (mesures réelles). */
export interface EtatModule {
  id: string;
  nom: string;
  role: string;
  /** actif | suspendu (recovery-manager après N échecs consécutifs). */
  statut: "actif" | "suspendu";
  /** Date ISO jusqu'à laquelle le module est suspendu (ré-armement auto). */
  suspenduJusquA?: string;
  /** Cause de la suspension (traçabilité). */
  suspenduRaison?: string;
  /** Date ISO du dernier tick tenté. */
  dernierTickLe?: string;
  /** Date ISO du dernier tick en succès. */
  dernierSuccesLe?: string;
  /** Compteurs cumulés depuis le démarrage du core. */
  ticks: number;
  succes: number;
  echecs: number;
  /** Échecs consécutifs (remis à zéro à chaque succès). */
  echecsConsecutifs: number;
  /** Dernier rapport honnête du module (ou dernier message d'échec). */
  dernierMessage?: string;
  /** Causes des dernières erreurs (anneau borné, 5 entrées). */
  dernieresErreurs: string[];
}

/** Persistance de l'état du core (var/autonomous/etat.json, reprise). */
export interface EtatPersisteCore {
  version: number;
  demarreLe: string;
  /** Dernier cycle connu (reprise du compteur après redémarrage). */
  cycle: number;
  /** Persistance la plus récente. */
  persisteLe: string;
  modules: Record<string, EtatModule>;
  /** Tâches non terminées au moment de la persistance (reprise après crash). */
  tachesOuvertes: Tache[];
}

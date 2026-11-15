/**
 * Types du protocole d'agents décentralisés Gen3ia.
 *
 * PRINCIPE FONDATEUR : chaque nœud de l'essaim fait tourner des
 * mini-agents spécialisés (veille, tri, calcul, code, automatisation)
 * qui communiquent par impulsions d'ondes légères via WebRTC — mais
 * TOUS les agents restent connectés à l'IA principale Gen3 : chaque
 * résultat remonte au cortex, et seules les décisions du cortex
 * ouvrent une nouvelle tâche. L'essaim est le muscle, Gen3 est le
 * système nerveux central.
 *
 * Le serveur n'apparaît QUE pour la signalisation (enveloppes courtes) :
 * aucune donnée d'inférence, aucun document, aucune compétence ne
 * transite par lui — tout voyage de navigateur à navigateur.
 */

/** Spécialités des mini-agents embarqués dans chaque nœud. */
export type TypeAgent = "veille" | "tri" | "calcul" | "code" | "automatisation";

/** Cycle de vie d'un mini-agent. */
export type EtatAgent = "veille" | "actif" | "surcharge" | "hors-ligne";

/** Statuts d'une tâche distribuée dans l'essaim. */
export type StatutTache =
  | "en-attente"
  | "distribuee"
  | "en-cours"
  | "terminee"
  | "echouee"
  | "orpheline";

/** Priorités de tâche (le cortex Gen3 peut urger une tâche critique). */
export type PrioriteTache = "basse" | "normale" | "haute" | "critique";

/**
 * Une tâche d'agent : la charge utile est un objet JSON léger (jamais de
 * binaire lourd) — les données volumineuses vivent dans les coffres
 * locaux chiffrés des nœuds, seuls les descripteurs voyagent.
 */
export interface TacheAgent {
  id: string;
  type: TypeAgent;
  /** Charge utile libre mais compacte (≤ 8 Ko) selon la spécialité. */
  charge: Record<string, unknown>;
  priorite: PrioriteTache;
  emiseA: number;
  /** Identifiant du nœud émetteur (cortex qui commande la tâche). */
  emetteur: string;
  /** Nœud qui a pris la tâche (vide tant que non distribuée). */
  attribueA?: string;
  statut: StatutTache;
  /** Résultat normalisé produit par l'agent exécutant. */
  resultat?: ResultatAgent;
  /** Millisecondes au-delà desquelles l'onde est déclarée orpheline. */
  delaiMs: number;
}

/** Résultat normalisé renvoyé par tout mini-agent à l'IA principale. */
export interface ResultatAgent {
  /** Synthèse lisible par l'IA principale et l'utilisateur. */
  resume: string;
  /** Données structurées (filtrées, bornées) pour le cortex. */
  donnees?: Record<string, unknown>;
  /** Confiance de l'agent dans son résultat ∈ [0, 1]. */
  confiance: number;
}

/** Un mini-agent spécialisé : l'unité d'exécution de l'essaim. */
export interface MicroAgent {
  id: string;
  nom: string;
  type: TypeAgent;
  description: string;
  etat: EtatAgent;
  tachesTraitees: number;
  tachesEchouees: number;
  /** Charge relative ∈ [0, 1] (file locale de l'agent). */
  charge: number;
  /** Dernier battement d'onde de l'agent (ms epoch). */
  dernierBattement: number;
}

/**
 * Message d'agents transporté sur le canal WebRTC « agents » (et
 * dérivé par cascade TTL comme les paquets d'ondes W-DNN). Chaque type
 * de message correspond à un temps du protocole de l'essaim :
 *
 *  - "annonce"   : présence + spécialités d'un nœud (diffusion) ;
 *  - "tache"     : le cortex ouvre une tâche (diffusion ou visée) ;
 *  - "resultat"  : un agent renvoie son compte-rendu au cortex ;
 *  - "battement" : onde de vie — l'amplitude porte la santé du nœud ;
 *  - "sos"       : rupture détectée, l'onde orpheline est réattribuée ;
 *  - "requete"   : onde de requête sémantique (RAG décentralisé) ;
 *  - "fragment"  : fragment de RAG décentralisé (réponse anonyme) ;
 *  - "competence": paquet d'ondes exécutable (injection de compétence).
 */
export type TypeMessageAgent =
  | "annonce"
  | "tache"
  | "resultat"
  | "battement"
  | "sos"
  | "requete"
  | "fragment"
  | "competence";

export interface MessageAgent {
  /** Version du protocole. */
  v: 1;
  /** Identifiant unique (déduplication des cascades). */
  mid: string;
  /** Nœud émetteur. */
  de: string;
  /** Nœud visé (absent = diffusion à tout l'essaim). */
  vers?: string;
  type: TypeMessageAgent;
  /** Charge typée selon `type`. */
  charge: unknown;
  /** Sauts restants (cascade anti-boucle). */
  ttl: number;
  ts: number;
}

/** Charge de "annonce" : les spécialités offertes par un nœud. */
export interface ChargeAnnonce {
  nom: string;
  specialites: TypeAgent[];
  /** Capacité disponible ∈ [0, 1] (1 = libre, prêt à exécuter). */
  capacite: number;
}

/** Charge de "resultat" : le compte-rendu d'un agent à l'IA principale. */
export interface ChargeResultat {
  tacheId: string;
  type: TypeAgent;
  resultat: ResultatAgent;
  /** Nœud exécutant (pour la ré-attribution en cas de perte). */
  noeud: string;
}

/** Charge de "battement" : l'onde de vie d'un nœud. */
export interface ChargeBattement {
  /** Amplitude de l'onde de vie ∈ [0, 1] — sa chute signale la mort. */
  amplitude: number;
  capacite: number;
  tachesEnCours: number;
}

/** Charge de "sos" : ré-attribution d'une onde orpheline. */
export interface ChargeSos {
  tache: TacheAgent;
  /** Nœud dont la rupture d'amplitude a été détectée. */
  noeudPerdu: string;
  /** Nombre de ré-attributions déjà subies par cette tâche. */
  generation: number;
}

/**
 * Charge de "requete" : onde de requête sémantique ZÉRO-CONNAISSANCE.
 * La question n'est jamais transmise — seulement la SIGNATURE creuse
 * de son vecteur (dimensions hachées + poids). Les pairs comparent
 * cette signature à leur index local chiffré, sans jamais révéler ce
 * qu'ils possèdent : ils répondent ou se taisent, anonymement.
 */
export interface ChargeRequete {
  requeteId: string;
  /** Dimensions actives du vecteur creux (indices hachés). */
  dims: number[];
  /** Poids correspondants (normalisés, arrondis à 3 décimales). */
  poids: number[];
  /** Seuil de similarité exigé par le demandeur ∈ [0, 1]. */
  seuil: number;
  /** Nœud à qui répondre (l'onde part en diffusion, la réponse est visée). */
  emetteur: string;
}

/**
 * Charge de "fragment" : réponse anonyme à une onde de requête
 * sémantique. Le fragment ne contient JAMAIS le document source :
 * seulement l'extrait pertinent, son empreinte et son score — le
 * répondant reste invisible (la réponse part sans identité utile).
 */
export interface ChargeFragment {
  requeteId: string;
  extrait: string;
  /** Empreinte FNV du fragment (déduplication entre répondants). */
  empreinte: string;
  /** Similarité cosinus locale ∈ [0, 1]. */
  score: number;
  /** Étiquette facultative posée par le détenteur (jamais le contenu). */
  etiquette?: string;
}

/** Charge de "competence" : un fragment de module exécutable. */
export interface ChargeCompetence {
  moduleId: string;
  version: number;
  fragment: number;
  total: number;
  /** Tranche de code UTF-16 encodée en base64. */
  morceau: string;
  /** Métadonnées du module (répétées au fragment 0). */
  meta?: MetaCompetence;
}

/** Métadonnées déclaratives d'une compétence injectable. */
export interface MetaCompetence {
  id: string;
  nom: string;
  description: string;
  /** Nombre de fragments attendus. */
  total: number;
  /** Empreinte SHA-256 (hex) du code COMPLET — l'intégrité juge. */
  empreinte: string;
  /** Octets de code (plafond : 32 Ko par compétence). */
  taille: number;
  emetteur: string;
  ts: number;
}

/** Événement de résilience (journal de la résonance de phase). */
export interface EvenementResilience {
  id: string;
  ts: number;
  type: "rupture" | "reattribution" | "recouvrement";
  /** Tâche concernée (si applicable). */
  tacheId?: string;
  noeudPerdu?: string;
  noeudRelais?: string;
  /** Amplitude observée au moment de l'événement ∈ [0, 1]. */
  amplitude?: number;
  detail: string;
}

/** Plafonds du protocole d'agents (honnêteté : bornes explicites). */
export const BORNES_AGENTS = {
  /** Taille maximale d'une charge de tâche (JSON.stringify). */
  tailleChargeTache: 8 * 1024,
  /** Taille maximale d'un module de compétence (code source). */
  tailleCompetence: 32 * 1024,
  /** Taille d'un fragment de compétence transporté par onde. */
  tailleFragmentCompetence: 4 * 1024,
  /** TTL de cascade par défaut. */
  ttlDefaut: 2,
  /** Battement d'onde de vie par défaut (ms). */
  periodeBattement: 1500,
  /** Amplitude sous laquelle l'onde de vie est déclarée rompue. */
  seuilAmplitude: 0.25,
  /** Délai par défaut avant déclaration d'orphelin (ms). */
  delaiOrphelin: 6000,
  /** Génération maximale de ré-attribution par tâche. */
  generationsMax: 3,
  /** Nombre maximal d'agents locaux par nœud. */
  agentsParNoeud: 5,
} as const;

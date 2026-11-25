/**
 * COMPUTE TYPES — contrats du gestionnaire matériel central Gen3ia
 * (mission WEBGPU Phase 2). Le cerveau central est le SEUL décideur :
 * ces types portent la tâche, les capacités réelles et la décision
 * MOTIVÉE (jamais « WebGPU dispo donc WebGPU »).
 */

/** Moteurs disponibles (fallback CPU TOUJOURS présent). */
export type MoteurCalcul = "cpu" | "webgpu" | "hybride";

/** Familles d'opérations (classification Phase 1 — GEN3IA_WEBGPU_AUDIT.md). */
export type FamilleCalcul =
  | "ondulatoire"       // propagation grille dense — GPU par nature
  | "matriciel"         // matvec/produits par lot — GPU candidat
  | "elementaire"       // opérations élément sur grands tableaux
  | "reduction"         // somme/max/similarité par lot
  | "neuronal"          // réseau Gen3 — CPU (déterminisme, graphe clairsemé)
  | "multimodal"        // rasterisation/mix RPIA, média navigateur
  | "generique";

/** Tâche de calcul soumise au Compute Manager. */
export interface TacheCalcul {
  /** Identifiant libre (traçabilité). */
  nom: string;
  famille: FamilleCalcul;
  /** Nombre d'éléments indépendants (grille, neurones, lots). */
  elements: number;
  /** Octets lus depuis le CPU vers le GPU (entrée). */
  octetsEntree: number;
  /** Octets ramenés du GPU vers le CPU (sortie). */
  octetsSortie: number;
  /** Mémoire GPU nécessaire estimée (octets). */
  memoireOctets: number;
  /** La tâche tolère-t-elle un ordre de réduction non strict ? */
  tolererReductionNonStricte?: boolean;
}

/** Capacités matérielles réellement détectées (aucune invention). */
export interface CapacitesMateriel {
  /** WebGPU réellement utilisable (adaptateur + device obtenus). */
  webgpuDisponible: boolean;
  /** Raison honnête d'indisponibilité (Node, navigateur sans WebGPU…). */
  raisonIndisponibilite?: string;
  adaptateur?: string;
  /** maxBufferSize déclaré par l'adaptateur (octets) — si exposé. */
  maxBufferSizeOctets?: number;
  /** Famille matérielle si sondée (compilateur hardware ondes). */
  familleGpu?: string;
  /** Environnement d'exécution. */
  environnement: "node" | "navigateur" | "serveur";
}

/** Capacités CPU réellement mesurables (mission Phase 2 — A). */
export interface CapacitesCpu {
  /** Cœurs logiques si l'environnement les expose, sinon 1 (honnête). */
  cœursLogiques: number;
  /** Mémoire du process lorsque mesurable (octets), sinon undefined. */
  memoireDisponibleOctets?: number;
  /** Contraintes d'environnement déclarées (serverless, navigateur…). */
  contraintes: string[];
  cpuDisponible: boolean;
}

/** Décision MOTIVÉE du router (traçable, auditable). */
export interface DecisionCalcul {
  moteur: MoteurCalcul;
  /** Raison explicite citant les facteurs (taille, transfert, énergie…). */
  raison: string;
  /** Facteurs mesurés/estimés ayant porté la décision. */
  facteurs: {
    elements: number;
    octetsTransfert: number;
    seuilElements: number;
    /** Estimation énergétique relative (CPU=1, GPU=coût transfert+calcul). */
    coutEstimeCpu: number;
    coutEstimeGpu: number;
  };
}

/** Profil de fonctionnement (Phase 6 — influences réelles sur la policy). */
export type ProfilEnergie = "ECO" | "BALANCED" | "PERFORMANCE" | "MOBILE" | "SERVER";

/** Mesure d'une exécution (réelle : durée CPU ; estimée : énergie). */
export interface MesureCalcul {
  nomTache: string;
  moteur: MoteurCalcul;
  /** Moteur DÉCIDÉ (avant fallback). */
  moteurDemande?: MoteurCalcul;
  dureeMs: number;
  /** true si un repli CPU a eu lieu après un échec GPU. */
  fallback: boolean;
  raisonFallback?: string;
  /** Énergie : "mesuree" si compteur matériel, sinon "estimee". */
  energie: { valeur: number; unite: "J" | "unite-relative"; nature: "mesuree" | "estimee" };
}

/** Seuils de la politique (auditables — pas de magie). */
export const SEUILS_CALCUL = {
  /** En dessous : le coût de transfert CPU↔GPU dépasse le gain. */
  elementsMinGpu: 4096,
  /** Au-delà : le coût de transfert devient dominant (petites sorties). */
  ratioTransfertMax: 64,
  /** Mémoire GPU max demandée sans confirmation device (octets). */
  memoirePrudenceOctets: 512 * 1024 * 1024,
} as const;

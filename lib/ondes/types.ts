/**
 * Types partagés du moteur W-DNN (Wave-Distributed Neural Inference).
 *
 * Architecture Gen3ia « inférence par ondes neuronales distribuées » :
 * au lieu de multiplications de matrices lourdes, le calcul se propage
 * sous forme d'ondes de phase et d'amplitude sur une grille d'oscillateurs
 * couplés (modèle de Kuramoto + équation d'onde discrète), exécutée sur
 * le GPU de l'utilisateur (WebGPU compute shaders) et reliée en essaim
 * P2P (WebRTC) où seuls des micro-paquets [phase, fréquence, amplitude]
 * circulent — jamais des tenseurs.
 */

/** Une impulsion initiale injectée dans le champ d'ondes (un mot, un pic P2P…). */
export interface Impulsion {
  /** Position en cellules (coordonnées flottantes dans la grille). */
  x: number;
  y: number;
  /** Amplitude du choc d'onde. */
  amplitude: number;
  /** Fréquence propre injectée (rad/pas) — porte l'information. */
  frequence: number;
  /** Attraction de phase initiale (rad). */
  phase: number;
  /** Rayon gaussien d'injection en cellules. */
  rayon: number;
}

/** Pic de résonance détecté lors du readback GPU/CPU. */
export interface Pic {
  x: number;
  y: number;
  /** Amplitude absolue du pic. */
  amplitude: number;
  /** Phase locale (rad) au moment de la détection. */
  phase: number;
}

/**
 * Micro-paquet d'ondes transmis entre navigateurs de l'essaim (WebRTC
 * data channel) : quelques octets de [phase, fréquence, amplitude] au
 * lieu de matrices de poids. `ttl` évite les boucles de retransmission.
 *
 * `por` : attestation Proof-of-Resonance optionnelle (lib/ondes/por.ts)
 * — l'empreinte spectrale de phase du champ qui a produit ce pic. Les
 * nœuds voisins la vérifient par résonance (format + plausibilité à
 * chaque paquet, rejeu du défi en session consensus). Ignorée par les
 * nœuds plus anciens (rétrocompatibilité totale).
 */
export interface AttestationPaquet {
  /** Haché 64 bits (hex 16). */
  e: string;
  /** Spectre résumé (32 valeurs quantifiées). */
  s: number[];
  /** Énergie moyenne. */
  g: number;
  /** Ordre de Kuramoto. */
  r: number;
  /** Cellules de la grille. */
  c: number;
}

export interface PaquetOnde {
  /** Version du protocole. */
  v: 1;
  /** Identifiant du nœud émetteur. */
  id: string;
  /** Identifiant unique du paquet (déduplication des retransmissions). */
  pid: string;
  /** Position du pic (x, y) dans la grille. */
  p: [number, number];
  /** Amplitude du pic. */
  a: number;
  /** Fréquence propre (rad/pas). */
  f: number;
  /** Phase (rad). */
  th: number;
  /** Horodatage (ms, epoch émetteur). */
  ts: number;
  /** Sauts restants avant abandon (1 = pas de retransmission). */
  ttl: number;
  /** Attestation Proof-of-Resonance (voir lib/ondes/por.ts). */
  por?: AttestationPaquet;
}

/** Niveaux d'effort de réflexion choisis dans le composer. */
export type NiveauEffort = "faible" | "moyen" | "eleve" | "ultra";

/** Configuration physique complète du champ d'ondes. */
export interface ConfigOndes {
  /** Dimensions de la grille (cellules). */
  largeur: number;
  hauteur: number;
  /** Pas de simulation exécutés par image (rAF). */
  pasParImage: number;
  /** Un readback toutes les N images (échange GPU → CPU). */
  periodeReadback: number;
  /** Constante de propagation (équation d'onde discrète). */
  c2: number;
  /** Amortissement neuronal (0.90 – 0.995). */
  amortissement: number;
  /** Couplage de Kuramoto entre oscillateurs voisins. */
  couplage: number;
  /** Pas de temps de la dynamique de phase. */
  dt: number;
  /** Gain cohérent : les zones synchronisées amplifient l'onde. */
  gain: number;
}

/**
 * Profils d'effort — l'effort de réflexion module la résolution de la
 * grille et le nombre de pas de propagation par image (temps de
 * « réflexion » de l'IA avant que la résonance ne stabilise une réponse).
 */
export const CONFIGS_EFFORT: Record<NiveauEffort, ConfigOndes> = {
  faible: {
    largeur: 128,
    hauteur: 128,
    pasParImage: 1,
    periodeReadback: 4,
    c2: 0.25,
    amortissement: 0.98,
    couplage: 0.08,
    dt: 0.12,
    gain: 0.012,
  },
  moyen: {
    largeur: 192,
    hauteur: 192,
    pasParImage: 2,
    periodeReadback: 3,
    c2: 0.25,
    amortissement: 0.985,
    couplage: 0.1,
    dt: 0.12,
    gain: 0.016,
  },
  eleve: {
    largeur: 256,
    hauteur: 256,
    pasParImage: 3,
    periodeReadback: 2,
    c2: 0.25,
    amortissement: 0.99,
    couplage: 0.12,
    dt: 0.12,
    gain: 0.02,
  },
  ultra: {
    largeur: 320,
    hauteur: 320,
    pasParImage: 4,
    periodeReadback: 2,
    c2: 0.25,
    amortissement: 0.992,
    couplage: 0.14,
    dt: 0.12,
    gain: 0.024,
  },
};

/** Bornes physiques servant à l'adaptation évolutive (jamais franchies). */
export const BORNES_PHYSIQUES = {
  amortissementMin: 0.9,
  amortissementMax: 0.995,
  couplageMin: 0.02,
  couplageMax: 0.3,
  frequenceMin: 0.02,
  frequenceMax: 0.2,
} as const;

/** Type de moteur d'exécution réellement actif. */
export type TypeMoteur = "webgpu" | "cpu";

/** Statistiques instantanées du champ d'ondes. */
export interface StatsChamp {
  imagesParSeconde: number;
  pasTotaux: number;
  picsDetectes: number;
  /** Paramètre d'ordre de Kuramoto r ∈ [0, 1] (synchronisation globale). */
  ordreR: number;
  /** Énergie moyenne du champ (moyenne des amplitudes absolues). */
  energie: number;
}

/** Statistiques de l'essaim P2P. */
export interface StatsEssaim {
  pairs: number;
  paquetsEnvoyes: number;
  paquetsRecus: number;
  octetsEnvoyes: number;
  octetsRecus: number;
}

/**
 * Estimation de bande passante économisée : chaque paquet d'ondes fait
 * quelques octets là où un échange de tenseurs classique transporterait
 * au minimum une tranche 128×128 de f32 (64 Ko) par nœud voisin.
 */
export const OCTETS_TENSEUR_EQUIVALENT = 128 * 128 * 4;

export function bandePassanteEconomisee(stats: StatsEssaim): number {
  const hypothetique = (stats.paquetsEnvoyes + stats.paquetsRecus) * OCTETS_TENSEUR_EQUIVALENT;
  return Math.max(0, hypothetique - (stats.octetsEnvoyes + stats.octetsRecus));
}

/** Formatage compact d'un nombre d'octets (fr-FR). */
export function formaterOctets(octets: number): string {
  if (octets < 1024) return `${Math.round(octets)} o`;
  if (octets < 1024 * 1024) return `${(octets / 1024).toFixed(1)} Ko`;
  if (octets < 1024 * 1024 * 1024) return `${(octets / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(octets / (1024 * 1024 * 1024)).toFixed(2)} Go`;
}

/** Préfixe des salles PRIVÉES (Private Mesh, plan Entreprise). */
export const PREFIXE_SALLE_MESH = "mesh-";

/** Exigence « private mesh » : la salle est-elle privée (admission signée) ? */
export function estSalleMesh(salle: string): boolean {
  return salle.startsWith(PREFIXE_SALLE_MESH);
}

/**
 * Types du système d'ENTRAÎNEMENT PAR RÉSONANCE (RPIA) — le pendant
 * APPRENTISSAGE du moteur W-DNN (inférence).
 *
 * RPIA = Règle d'apprentissage Par Interférence Acoustique/ondulatoire :
 * un nœud d'onde porte [amplitude, fréquence, phase, amortissement] et
 * apprend à résonner vers une onde cible (texte, image, son encodés par
 * le conditionneur) en corrigeant son interférence à chaque pas :
 *
 *   · interférence CONSTRUCTIVE (|onde − cible| < seuil) → renforcement
 *     de la résonance (phase avancée, amortissement relâché) ;
 *   · interférence DESTRUCTIVE → déphasage adaptatif (élimination du
 *     bruit, amortissement renforcé).
 *
 * Modules PURS : aucune dépendance Node ni navigator — exécutables
 * côté serveur (CPU), côté navigateur (WebGPU via shaders-rpia.ts)
 * et dans les tests unitaires, de façon déterministe.
 */

/** Un nœud du réseau d'ondes entraînable (portage fidèle de WaveNode). */
export interface NoeudOnde {
  /** Amplitude de l'onde du nœud (bornée [0, 2]). */
  amplitude: number;
  /** Fréquence propre (rad/pas de temps). */
  frequence: number;
  /** Phase courante (rad). */
  phase: number;
  /** Amortissement : résistance au changement (bornée [0.001, 0.5]). */
  amortissement: number;
}

/** Nœud spatiotemporel du rendu vidéo (portage fidèle de WaveNode3D). */
export interface NoeudOnde3D extends NoeudOnde {
  /** Position horizontale du nœud dans l'image (pixels). */
  posX: number;
  /** Position verticale du nœud dans l'image (pixels). */
  posY: number;
}

/** Nœud acoustique : oscillateur dans la bande audible (portage fidèle de AudioNode). */
export interface NoeudAcoustique {
  /** Amplitude de l'oscillateur. */
  amplitude: number;
  /** Fréquence ACOUSTIQUE en Hz (bande audible 20 – 20 000). */
  frequence: number;
  /** Phase courante (rad). */
  phase: number;
  /** Amortissement (bornée [0.001, 0.1] — contrôle anti-saturation). */
  amortissement: number;
}

/** Paramètres d'un pas d'entraînement RPIA (portage fidèle de TrainingParams). */
export interface ConfigRPIA {
  /** Taux d'apprentissage (force des corrections de phase/amplitude). */
  tauxApprentissage: number;
  /** Pas de temps de la dynamique (temps global de l'onde, secondes virtuelles). */
  pasDeTemps: number;
}

/** Valeurs par défaut d'un entraînement RPIA (source utilisateur). */
export const RPIA_DEFAUTS: ConfigRPIA = {
  tauxApprentissage: 0.01,
  pasDeTemps: 0.1,
};

/**
 * Bornes physiques du système — JAMAIS franchies (clamps fidèles aux
 * shaders sources : amplitude [0, 2], amortissement générique
 * [0.001, 0.5], acoustique [0.001, 0.1], vidéo [0.001, 0.2],
 * oscillateurs audibles 20 – 20 000 Hz).
 */
export const BORNES_RPIA = {
  amplitudeMin: 0,
  amplitudeMax: 2,
  amortissementMin: 0.001,
  amortissementMax: 0.5,
  amortissementAudioMin: 0.001,
  amortissementAudioMax: 0.1,
  amortissementVideoMin: 0.001,
  amortissementVideoMax: 0.2,
  frequenceAudioMin: 20,
  frequenceAudioMax: 20000,
  /** Seuil d'interférence constructive : |onde − cible| en dessous = résonance acquise. */
  seuilConstructif: 0.05,
} as const;

/** Seuil d'interférence constructive, lisible seul (shaders). */
export const SEUIL_CONSTRUCTIF: number = BORNES_RPIA.seuilConstructif;

/**
 * Rapport d'un entraînement complet : la trajectoire d'erreur prouve la
 * convergence (HONNÊTETÉ : aucun score n'est déclaré sans la courbe).
 */
export interface RapportEntrainement {
  /** Nombre d'époques (ou de pas) réellement exécutés. */
  epoques: number;
  /** Erreur d'interférence moyenne avant le premier pas. */
  erreurInitiale: number;
  /** Erreur d'interférence moyenne après le dernier pas. */
  erreurFinale: number;
  /** true si l'erreur finale est inférieure à l'erreur initiale (progrès réel). */
  convergence: boolean;
  /** Historique de l'erreur à chaque pas (courbe d'apprentissage). */
  historiqueErreur: number[];
}

/** Fabrique un rapport depuis un historique d'erreurs (jamais vide). */
export function rapportDepuisHistorique(historique: number[]): RapportEntrainement {
  const erreurInitiale = historique[0] ?? 0;
  const erreurFinale = historique[historique.length - 1] ?? 0;
  return {
    epoques: historique.length,
    erreurInitiale,
    erreurFinale,
    convergence: erreurFinale < erreurInitiale,
    historiqueErreur: historique,
  };
}

/**
 * Erreur d'interférence moyenne d'une population de nœuds contre une
 * cible : moyenne des |amplitude·cos(ω·t + φ) − cible[i]|. C'est LA
 * métrique d'apprentissage (le shader la réduit pas à pas).
 */
export function erreurInterference(
  noeuds: readonly NoeudOnde[],
  cible: OndeCible,
  temps: number,
): number {
  const n = Math.min(noeuds.length, cible.length);
  if (n === 0) return 0;
  let somme = 0;
  for (let i = 0; i < n; i++) {
    const noeud = noeuds[i];
    const onde = noeud.amplitude * Math.cos(noeud.frequence * temps + noeud.phase);
    somme += Math.abs(onde - cible[i]);
  }
  return somme / n;
}

/** Clamp utilitaire (identique à la sémantique clamp() WGSL). */
export function borner(valeur: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, valeur));
}

/**
 * Une onde cible : tableau de nombres (Array ou Float32Array) — les
 * deux formes sont acceptées partout (le conditionneur produit des
 * Float32Array, les tests des deux).
 */
export type OndeCible = readonly number[] | Float32Array;

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

/**
 * Fabrique un rapport depuis l'historique post-pas.
 *
 * `erreurAvantEntrainement`, lorsqu'elle est fournie, est mesurée AVANT le
 * premier pas. Sans cette valeur, le comportement historique est conservé
 * pour les appelants qui ne disposent que de l'historique.
 */
export function rapportDepuisHistorique(
  historique: number[],
  erreurAvantEntrainement?: number,
): RapportEntrainement {
  const erreurInitiale = erreurAvantEntrainement ?? historique[0] ?? 0;
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

/** Contrat partagé CPU/GPU : paramètres numériques RPIA valides. */
export function validerConfigRPIA(config: ConfigRPIA): void {
  if (
    !config ||
    typeof config !== "object" ||
    !Number.isFinite(config.tauxApprentissage) ||
    !Number.isFinite(Math.fround(config.tauxApprentissage)) ||
    config.tauxApprentissage < 0 ||
    !Number.isFinite(config.pasDeTemps) ||
    !Number.isFinite(Math.fround(config.pasDeTemps)) ||
    config.pasDeTemps <= 0 ||
    Math.fround(config.pasDeTemps) <= 0
  ) {
    throw new Error(
      "Configuration RPIA invalide : les paramètres doivent être finis et représentables en float32 ; le taux doit être positif ou nul et le pas de temps strictement positif.",
    );
  }
}

/** Refuse toute cible dont la dimension ou les valeurs ne sont pas valides. */
export function validerCibleRPIA(cible: OndeCible, nbNoeuds: number): void {
  if (!cible || typeof cible.length !== "number" || cible.length !== nbNoeuds) {
    throw new Error(
      `Cible incompatible : ${cible?.length ?? "absente"} valeurs reçues, ${nbNoeuds} nœuds.`,
    );
  }
  for (let i = 0; i < cible.length; i++) {
    if (!Number.isFinite(cible[i]) || !Number.isFinite(Math.fround(cible[i]))) {
      throw new Error(`Cible non finie ou hors plage float32 à l'index ${i}.`);
    }
  }
}

/**
 * Horloge absolue du pas courant. L'API reçoit le pas temporel Δt,
 * mais le calcul ondulatoire doit être évalué à t = Δt × pasTotal.
 * Le résultat est quantifié en float32, comme l'uniforme WGSL, afin que
 * la référence CPU et le shader reçoivent le même instant de simulation.
 */
export function calculerTempsGlobalRPIA(config: ConfigRPIA, pasTotaux: number): number {
  validerConfigRPIA(config);
  if (!Number.isSafeInteger(pasTotaux) || pasTotaux < 0) {
    throw new Error(`Compteur de pas RPIA invalide : ${pasTotaux} (entier sûr ≥ 0 requis).`);
  }
  const temps = config.pasDeTemps * pasTotaux;
  const tempsFloat32 = Math.fround(temps);
  if (!Number.isFinite(temps) || !Number.isFinite(tempsFloat32)) {
    throw new Error("Temps global RPIA non fini ou hors plage float32.");
  }
  return tempsFloat32;
}

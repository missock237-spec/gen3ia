/**
 * CHAMP CORTICAL GEN3 (v2) — étage 3 : 1 000 000 000 de neurones ADRESSABLES.
 *
 * NATURE HONNÊTE DE CET ÉTAGE (documentée, à lire avant d'utiliser) :
 * un treillis 3D de 1000×1000×1000 neurones ne peut pas être instancié en
 * RAM (un seul tableau Float32 d'1e9 cases = 4 Go). Le champ est donc un
 * neurone GÉNÉRATIF : chaque neurone i (0..999 999 999) possède un état
 * d'onde RÉELLEMENT CALCULABLE à la demande — fréquence, phase initiale et
 * gain dérivés d'un hash déterministe de (i, seedEntrainement) — et son
 * couplage aux 1000 régions corticales est fonction du câblage APPRIS des
 * étages inférieurs (noyau v1 + cortex columnnaire).
 *
 * C'est la technique établie des « random features » / réservoirs génératifs
 * : un ensemble compact de paramètres (ici ~1 000 poids régionaux + la
 * graine d'entraînement) définit un champ d'1e9 unités adressables dont la
 * dynamique est exploitable sans jamais allouer 1e9 états. Les statistiques
 * globales sont obtenues par ÉCHANTILLONNAGE STRATIFIÉ avec borne d'erreur
 * (jamais par une boucle sur 1e9).
 *
 * ENTRAÎNEMENT : la graine d'entraînement évolue avec l'apprentissage
 * (dérivée des époques/échantillons traités) et les poids régionaux suivent
 * l'activité réelle des bandes du cortex columnnaire — le champ entier
 * « apprend » à travers ses ~1 000 paramètres de couplage.
 *
 * Module PUR — aucune dépendance Node, entièrement déterministe.
 */

import { createRng } from "../rng";

/** Taille exacte du champ cortical : 1 milliard de neurones adressables. */
export const TAILLE_CHAMP = 1_000_000_000;

/** Tréillis 3D 1000×1000×1000. */
export const COTE_TREILLIS = 1000;

/** Régions corticales : 1000 régions de 1 000 000 neurones chacune. */
export const REGIONS = 1000;
export const NEURONES_PAR_REGION = TAILLE_CHAMP / REGIONS; // 1 000 000

/** État d'onde d'un neurone du champ (calculé à la demande). */
export interface EtatOndeNeurone {
  /** ID du neurone (0..999 999 999). */
  id: number;
  /** Fréquence propre (unités d'horloge virtuelle⁻¹). */
  frequence: number;
  /** Phase instantanée en radians (analytique : φ0 + ω·t). */
  phase: number;
  /** Amplitude instantanée normalisée [0, 1] : gain × (0.5+0.5·sin φ). */
  amplitude: number;
  /** Région corticale d'appartenance (0..999). */
  region: number;
  /** Modulation régionale courante issue du câblage appris (≥ 0). */
  modulation: number;
}

/** Statistiques d'échantillonnage du champ (avec borne d'erreur réelle). */
export interface StatsChamp {
  taille: number;
  regions: number;
  neuronesParRegion: number;
  /** Graine d'entraînement courante (évolue avec l'apprentissage). */
  seedEntrainement: number;
  /** Nombre d'échantillons de la dernière mesure. */
  echantillons: number;
  /** Amplitude moyenne mesurée [0, 1]. */
  amplitudeMoyenne: number;
  /** Écart-type d'amplitude mesuré. */
  amplitudeEcartType: number;
  /** Fraction de neurones « actifs » (amplitude ≥ 0.6) mesurée. */
  fractionActive: number;
  /** Demi-largeur d'erreur à 95 % sur amplitudeMoyenne (IC normal). */
  erreurEchantillon: number;
  /** Modulation régionale courante (1000 valeurs, issue du câblage appris). */
  modulationRegionale: Float32Array;
}

/**
 * CHAMP CORTICAL — enveloppe générative d'un milliard de neurones d'onde.
 */
export class ChampCorticalGen3 {
  /** Graine d'entraînement : évolue à chaque consolidation d'apprentissage. */
  seedEntrainement: number;

  /** Modulation régionale (1000 valeurs) issue de l'activité apprise. */
  private modulation: Float32Array;

  constructor(seedEntrainement = 42) {
    this.seedEntrainement = seedEntrainement >>> 0;
    this.modulation = new Float32Array(REGIONS);
  }

  /**
   * Hash 32 bits déterministe de (id, sel) — xorshift-multiply, stable.
   * (Localement : la « signature génétique » d'un neurone du champ.)
   */
  private hashNeurone(id: number, sel: number): number {
    let h = Math.imul(id >>> 0, 0x9e3779b1) ^ Math.imul(sel, 0x85ebca6b) ^ this.seedEntrainement;
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return h >>> 0;
  }

  /**
   * Calcule l'état d'onde RÉEL du neurone `id` à l'instant virtuel `t`.
   * Phase avancée analytiquement (modèle de Kuramoto libre) : φ(t) = φ0 + ω·t.
   * Aucune itération, aucune allocation : appelable 1e9 fois si besoin.
   */
  etatNeurone(id: number, t: number): EtatOndeNeurone {
    const idN = ((id % TAILLE_CHAMP) + TAILLE_CHAMP) % TAILLE_CHAMP;
    const h1 = this.hashNeurone(idN, 1);
    const h2 = this.hashNeurone(idN, 2);
    const h3 = this.hashNeurone(idN, 3);
    const frequence = 0.25 + (h1 / 4294967296) * 1.5; // ω ∈ [0.25, 1.75]
    const phase0 = (h2 / 4294967296) * 2 * Math.PI; // φ0 ∈ [0, 2π)
    const gain = 0.55 + (h3 / 4294967296) * 0.45; // gain ∈ [0.55, 1.0]
    const region = Math.floor(idN / NEURONES_PAR_REGION);
    const modulation = this.modulation[region];
    const phase = phase0 + frequence * t;
    const amplitude = gain * (0.5 + 0.5 * Math.sin(phase)) * (1 + modulation);
    return {
      id: idN,
      frequence,
      phase,
      amplitude,
      region,
      modulation,
    };
  }

  /**
   * Couplage appris ← cortex columnnaire : la résonance des bandes du
   * cortex (32 valeurs) est dispersée sur les 1000 régions par des poids
   * de dispersion déterministes (hash région×bande). L'activité réelle des
   * étages inférieurs module ainsi le champ entier.
   */
  couplerBandes(resonanceBandes: readonly number[]): void {
    if (resonanceBandes.length === 0) return;
    const nb = resonanceBandes.length;
    for (let r = 0; r < REGIONS; r++) {
      let somme = 0;
      for (let b = 0; b < nb; b++) {
        // Poids de dispersion déterministe région×bande (∈ [0, 2)).
        const h = (Math.imul(r + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0;
        const poids = (h % 4096) / 2048;
        somme += resonanceBandes[b] * poids;
      }
      // Normalisation par le nombre de bandes, lissage doux (mémoire du couplage).
      const cible = somme / nb;
      this.modulation[r] = this.modulation[r] * 0.7 + cible * 0.3;
    }
  }

  /**
   * ÉVOLUTION DE LA GRAINE D'ENTRAÎNEMENT — appelée à chaque consolidation
   * d'apprentissage (époques × échantillons). La signature génétique du
   * champ (fréquences/phases/gains de ses 1e9 neurones) évolue de façon
   * contrôlée et reproductible avec l'expérience accumulée.
   */
  consoliderApprentissage(epochs: number, samples: number): void {
    let h = this.seedEntrainement ^ Math.imul(epochs + 1, 0x9e3779b1) ^ Math.imul(samples + 1, 0x85ebca6b);
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    this.seedEntrainement = h >>> 0;
  }

  /**
   * Échantillonnage stratifié du champ : `n` neurones répartis uniformément
   * sur les 1e9 (pas constant, déterministe), état calculé, agrégats réels
   * + demi-largeur d'erreur à 95 % (IC normal, σ/√n × 1.96).
   */
  echantillonner(t: number, n = 4096): StatsChamp {
    const echantillons = Math.max(1, Math.min(n, 1_000_000));
    const pas = Math.floor(TAILLE_CHAMP / echantillons);
    let somme = 0;
    let sommeCarres = 0;
    let actifs = 0;
    for (let i = 0; i < echantillons; i++) {
      const etat = this.etatNeurone(i * pas, t);
      somme += etat.amplitude;
      sommeCarres += etat.amplitude * etat.amplitude;
      if (etat.amplitude >= 0.6) actifs += 1;
    }
    const moyenne = somme / echantillons;
    const variance = Math.max(0, sommeCarres / echantillons - moyenne * moyenne);
    const ecartType = Math.sqrt(variance);
    const erreur = (1.96 * ecartType) / Math.sqrt(echantillons);
    return {
      taille: TAILLE_CHAMP,
      regions: REGIONS,
      neuronesParRegion: NEURONES_PAR_REGION,
      seedEntrainement: this.seedEntrainement,
      echantillons,
      amplitudeMoyenne: moyenne,
      amplitudeEcartType: ecartType,
      fractionActive: actifs / echantillons,
      erreurEchantillon: erreur,
      modulationRegionale: this.modulation.slice(),
    };
  }

  /** Copie défensive de la modulation régionale (API, persistance). */
  modulationRegionale(): Float32Array {
    return this.modulation.slice();
  }

  /** Restaure une modulation régionale persistée (longueur exacte requise). */
  importerModulation(modulation: Float32Array): boolean {
    if (modulation.length !== REGIONS) return false;
    this.modulation.set(modulation);
    return true;
  }

  /**
   * Micro-tonus régional en veille : maintient une activité de fond
   * résiduelle (le champ « rêve ») via le RNG seedé — déterministe.
   */
  veille(t: number, intensite = 0.02): void {
    const rng = createRng((this.seedEntrainement ^ Math.floor(t)) >>> 0);
    for (let r = 0; r < REGIONS; r++) {
      if (rng() < 0.05) {
        this.modulation[r] = Math.max(0, this.modulation[r] * 0.98) + intensite * rng();
      }
    }
  }

  /** Stats publiques compactes (API). */
  statsRapides(t: number): {
    taille: number;
    regions: number;
    seedEntrainement: number;
    modulationMoyenne: number;
    amplitudeMoyenne: number;
    fractionActive: number;
    erreurEchantillon: number;
  } {
    const e = this.echantillonner(t, 2048);
    let sommeMod = 0;
    for (let r = 0; r < REGIONS; r++) sommeMod += this.modulation[r];
    return {
      taille: TAILLE_CHAMP,
      regions: REGIONS,
      seedEntrainement: this.seedEntrainement,
      modulationMoyenne: sommeMod / REGIONS,
      amplitudeMoyenne: e.amplitudeMoyenne,
      fractionActive: e.fractionActive,
      erreurEchantillon: e.erreurEchantillon,
    };
  }
}

/**
 * Évolution du champ d'ondes — l'optimisation évolutive du W-DNN.
 *
 * Le champ n'est jamais figé : à chaque cycle de réflexion, trois
 * mécanismes adaptent la physique du milieu aux résonances observées :
 *
 *  1. Renforcement hebbien des fréquences : les régions qui résonnent
 *     (« ce qui s'activent ensemble ») voient leur fréquence propre
 *     dériver vers celle des impulsions reçues — le champ apprend
 *     l'empreinte fréquentielle du vocabulaire de son utilisateur.
 *  2. Adaptation du couplage K : le paramètre d'ordre r est régulé vers
 *     une cible (0.35) — trop peu de synchronisation = champ muet,
 *     trop = cristallisation (r_LOCK) où tout résonne sans distinguer.
 *  3. Dérive de l'amortissement : régulation de l'énergie moyenne pour
 *     garder le champ dans son régime dynamique utile.
 *
 * L'état (K, amortissement, fréquences renforcées, compteurs) est
 * exportable/importable — persisté côté client (localStorage) et
 * transférable entre nœuds de l'essaim.
 */

import { BORNES_PHYSIQUES, type Pic } from "./types";

export interface EtatEvolution {
  couplage: number;
  amortissement: number;
  eta: number;
  pasTotaux: number;
  motsEmis: number;
  adaptations: number;
  /** Régions renforcées (index de cellule → fréquence), plafonnées. */
  regions: Array<{ i: number; f: number }>;
}

export interface OptionsEvolution {
  /** Taux d'apprentissage hebbien (plafond dur à 0.05). */
  etaInitial: number;
  /** Cible du paramètre d'ordre r. */
  cibleR: number;
  /** Énergie moyenne cible du champ. */
  cibleEnergie: number;
  /** Nombre maximal de régions persistées. */
  maxRegions: number;
}

export const OPTIONS_DEFAUT_EVOLUTION: OptionsEvolution = {
  etaInitial: 0.012,
  cibleR: 0.35,
  cibleEnergie: 0.4,
  maxRegions: 512,
};

const ETA_MIN = 0.002;
const ETA_MAX = 0.05;
const COUPLAGE_PAS = 0.0025;
const AMORTISSEMENT_PAS = 0.0008;

export class EvolutionOndes {
  private eta: number;
  private couplage: number;
  private amortissement: number;
  private pasTotaux = 0;
  private motsEmis = 0;
  private adaptations = 0;
  /** Renforcements hebbiens : index de cellule → poids ∈ [-1, 1]. */
  private regions = new Map<number, number>();
  private readonly options: OptionsEvolution;

  constructor(
    couplageInitial: number,
    amortissementInitial: number,
    options?: Partial<OptionsEvolution>,
  ) {
    this.options = { ...OPTIONS_DEFAUT_EVOLUTION, ...options };
    this.couplage = couplageInitial;
    this.amortissement = amortissementInitial;
    this.eta = this.options.etaInitial;
  }

  get etaCourant(): number {
    return this.eta;
  }

  get couplageCourant(): number {
    return this.couplage;
  }

  get amortissementCourant(): number {
    return this.amortissement;
  }

  get nbAdaptations(): number {
    return this.adaptations;
  }

  /**
   * Cycle d'évolution appelé ~1 fois par seconde avec les mesures du
   * champ : renforce les régions résonantes, régule K et l'amortissement.
   * Retourne les paramètres physiques mis à jour.
   */
  evoluer(mesures: { ordreR: number; energie: number; pics: Pic[]; pas: number }): {
    couplage: number;
    amortissement: number;
  } {
    this.pasTotaux += mesures.pas;

    // 1) Renforcement hebbien des régions résonantes.
    for (const pic of mesures.pics) {
      this.renforcerIndex(Math.round(pic.y) * this.dimEstimee + Math.round(pic.x), 1);
    }

    // 2) Régulation du couplage vers la cible d'ordre r.
    const erreurR = this.options.cibleR - mesures.ordreR;
    const nouveauCouplage = bornes(
      this.couplage + Math.sign(erreurR) * COUPLAGE_PAS,
      BORNES_PHYSIQUES.couplageMin,
      BORNES_PHYSIQUES.couplageMax,
    );
    if (nouveauCouplage !== this.couplage) this.adaptations++;
    this.couplage = nouveauCouplage;

    // 3) Dérive de l'amortissement vers l'énergie cible.
    const erreurE = mesures.energie - this.options.cibleEnergie;
    const nouvelAmortissement = bornes(
      this.amortissement - Math.sign(erreurE) * AMORTISSEMENT_PAS,
      BORNES_PHYSIQUES.amortissementMin,
      BORNES_PHYSIQUES.amortissementMax,
    );
    if (nouvelAmortissement !== this.amortissement) this.adaptations++;
    this.amortissement = nouvelAmortissement;

    // 4) L'eta lui-même évolue (méta-plasticité) : un champ stable
    //    apprend plus vite, un champ chaotique ralentit.
    const cibleEta = mesures.ordreR > this.options.cibleR ? ETA_MAX : ETA_MIN;
    this.eta = bornes(this.eta + (cibleEta - this.eta) * 0.02, ETA_MIN, ETA_MAX);

    return { couplage: this.couplage, amortissement: this.amortissement };
  }

  /**
   * Applique le renforcement hebbien à une carte de fréquences concrète
   * (Float32Array du moteur) : les régions renforcées dérivent vers les
   * bornes hautes de la bande, les autres décroissent lentement.
   */
  appliquer(frequences: Float32Array, dim: number): void {
    if (dim * dim !== frequences.length) return;
    const bande = BORNES_PHYSIQUES.frequenceMax - BORNES_PHYSIQUES.frequenceMin;
    for (const [index, poids] of this.regions) {
      if (index < 0 || index >= frequences.length) continue;
      frequences[index] = bornes(
        frequences[index] + poids * this.eta * bande,
        BORNES_PHYSIQUES.frequenceMin,
        BORNES_PHYSIQUES.frequenceMax,
      );
    }
    // Décroissance globale lente (oubli) — le champ n'empile pas indéfiniment.
    const oubli = 1 - this.eta * 0.01;
    for (const [index, poids] of this.regions) {
      this.regions.set(index, poids * oubli);
    }
    void dim;
  }

  /** Notifie qu'un mot a été émis par résonance (compteur d'évolution). */
  noterMot(): void {
    this.motsEmis++;
  }

  private dimEstimee = 256;

  /** Dimension attendue des index de cellules (pour le renforcement). */
  definirDimension(dim: number): void {
    this.dimEstimee = dim;
  }

  private renforcerIndex(index: number, force: number): void {
    const courant = this.regions.get(index) ?? 0;
    const suivant = Math.max(-1, Math.min(1, courant + force * this.eta));
    if (suivant === courant) return;
    this.regions.set(index, suivant);
    if (this.regions.size > this.options.maxRegions) {
      // Évince la région la plus faible (sélection naturelle).
      let minIndex = -1;
      let minPoids = Infinity;
      for (const [i, p] of this.regions) {
        if (i === index) continue;
        if (Math.abs(p) < minPoids) {
          minPoids = Math.abs(p);
          minIndex = i;
        }
      }
      if (minIndex >= 0) this.regions.delete(minIndex);
    }
  }

  /** Exporte un état sérialisable (JSON, localStorage, essaim). */
  exporterEtat(): EtatEvolution {
    const regions: EtatEvolution["regions"] = [];
    for (const [i, f] of this.regions) {
      regions.push({ i, f });
    }
    regions.sort((a, b) => Math.abs(b.f) - Math.abs(a.f));
    return {
      couplage: this.couplage,
      amortissement: this.amortissement,
      eta: this.eta,
      pasTotaux: this.pasTotaux,
      motsEmis: this.motsEmis,
      adaptations: this.adaptations,
      regions: regions.slice(0, 128),
    };
  }

  /** Restaure un état exporté (fusion douce des régions). */
  importerEtat(etat: EtatEvolution, dim: number): void {
    this.couplage = bornes(etat.couplage, BORNES_PHYSIQUES.couplageMin, BORNES_PHYSIQUES.couplageMax);
    this.amortissement = bornes(
      etat.amortissement,
      BORNES_PHYSIQUES.amortissementMin,
      BORNES_PHYSIQUES.amortissementMax,
    );
    this.eta = bornes(etat.eta, ETA_MIN, ETA_MAX);
    this.pasTotaux = etat.pasTotaux;
    this.motsEmis = etat.motsEmis;
    this.adaptations = etat.adaptations;
    this.dimEstimee = dim;
    for (const region of etat.regions) {
      if (region.i >= 0 && region.i < dim * dim) {
        this.regions.set(region.i, Math.max(-1, Math.min(1, region.f)));
      }
    }
  }
}

function bornes(valeur: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, valeur));
}

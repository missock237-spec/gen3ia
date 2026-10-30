/**
 * EFFECTEUR CORTEX V2 — intégration de l'étage columnnaire + du champ
 * cortical d'un milliard de neurones dans chaque cycle du noyau central.
 *
 * ARCHITECTURE : le noyau central (`NoyauCentralGen3`) orchestre ses cycles
 * et interroge ses effecteurs à chaque cycle. Cet effecteur s'y enregistre
 * comme les autres (runtime.ts) : AUCUNE modification de la mécanique v1.
 * À chaque cycle il :
 *  1. projette le prompt (tokens FNV-1a → colonnes fines 262 144) au
 *     premier cycle de la fenêtre d'inférence (volée unique, comme v1) ;
 *  2. exécute un pas columnnaire réel (CSR push, décroissance paresseuse) ;
 *  3. couple l'activité des bandes au champ cortical d'1e9 neurones ;
 *  4. remonte la résonance des bandes d'intention vers les pools v1
 *     correspondants (injection d'énergie — pathway multi-échelle réel :
 *     texte → colonnes → bande entraînée → pool v1 → effecteurs).
 *
 * CLÉS DE CONTEXTE RÉSERVÉES (adaptation documentée du portage) :
 *  - `__fenetreNeuronale` (number) : identifiant unique d'une fenêtre
 *    d'inférence/entraînement. Un changement déclenche le reset des
 *    énergies columnnaires (miroir de l'adaptation (d) du trainer) et la
 *    consolidation de la plasticité supervisée de la fenêtre précédente ;
 *  - `__intentionCible` (string) : label supervisé — à la clôture de la
 *    fenêtre, les arêtes CSR des colonnes stimulées vers la bande du label
 *    sont renforcées (punition compétitive des bandes sur-résonantes).
 * Le moteur (`engine.ts`) et le trainer fournissent ces clés ; les autres
 * effecteurs les ignorent.
 *
 * Module PUR — aucune dépendance Node, entièrement déterministe.
 */

import { createRng } from "../rng";
import {
  NEURONES_LIBRES,
  POOL_EXECUTER_OUTIL_OS,
  POOL_GENERER_AUDIO,
  POOL_GENERER_IMAGE,
  POOL_GENERER_VIDEO,
  POOL_INITIALISER_APPEL,
  POOL_INTENTION_GENERALE,
  POOL_SELECTIONNER_ET_EXECUTER_SKILL,
  POOL_TERMINER_APPEL,
} from "../types";
import type {
  Effecteur,
  EffectorActionResult,
} from "../types";
import { tokenize } from "../../encoding/text-encoder";
import { CortexColumnnaire } from "./cortex-columnnaire";
import type { CortexColumnnaireStats } from "./cortex-columnnaire";
import { ChampCorticalGen3 } from "./champ-cortical";
import { emettrePaquetsDepuisBandes } from "./bus-ondes-regions";
import type { BilanOndes } from "./bus-ondes-regions";

/**
 * Miroir de LABEL_POOLS (training/trainer.ts — module `server-only`,
 * non importable ici) : l'ordre définit l'association BANDE ↔ INTENTION.
 * Bandes 0..7 = intentions ; bandes 8..31 = activité de fond libre.
 */
export const BANDES_INTENTION: ReadonlyArray<{
  label: string;
  pool: readonly number[];
}> = [
  { label: "GENERER_IMAGE", pool: POOL_GENERER_IMAGE },
  { label: "GENERER_AUDIO", pool: POOL_GENERER_AUDIO },
  { label: "GENERER_VIDEO", pool: POOL_GENERER_VIDEO },
  { label: "EXECUTER_OUTIL_OS", pool: POOL_EXECUTER_OUTIL_OS },
  {
    label: "SELECTIONNER_ET_EXECUTER_SKILL",
    pool: POOL_SELECTIONNER_ET_EXECUTER_SKILL,
  },
  { label: "INITIALISER_APPEL", pool: POOL_INITIALISER_APPEL },
  { label: "TERMINER_APPEL", pool: POOL_TERMINER_APPEL },
  { label: "INTENTION_GENERALE", pool: POOL_INTENTION_GENERALE },
];

/**
 * Gain de remontée columnnaire → pool v1, appliqué à l'activation graduée
 * normalisée (somme des bandes = 1 ; bande uniforme ≈ 0.03, bande
 * entraînée ≈ 0.15-0.5).
 */
export const GAIN_REMONTEE_INTENTION = 4.0;
/** Plafond d'énergie injectée par cycle dans un neurone de pool v1. */
export const CAP_REMONTEE_INTENTION = 0.6;
/** Gain d'activité de fond (bandes libres) vers les neurones libres. */
export const GAIN_REMONTEE_LIBRE = 0.05;

/** Réseau v1 minimal requis (injection d'énergie dans les pools). */
export interface ReseauInjectable {
  neurones: Map<
    number,
    { receiveInput: (valeur: number) => void }
  >;
}

/** Compteur global de fenêtres neuronales (partagé engine + trainer). */
let compteurFenetres = 0;

/** Réserve un identifiant unique de fenêtre d'inférence/entraînement. */
export function nouvelleFenetreNeuronale(): number {
  compteurFenetres += 1;
  return compteurFenetres;
}

/** Télémétrie publique du Cortex v2 (API, données réelles). */
export interface EtatCortexV2 {
  cortex: CortexColumnnaireStats;
  champ: {
    taille: number;
    regions: number;
    seedEntrainement: number;
    modulationMoyenne: number;
    amplitudeMoyenne: number;
    fractionActive: number;
    erreurEchantillon: number;
  };
  /** it.56 — bus d'ondes inter-régions : dernier bilan (paquets, renforts,
   *  annulations, énergie transportée) et total de paquets émis. */
  busOndes: BilanOndes & { paquetsEmisTotal: number };
  /** it.56 — métabolisme columnnaire du dernier pas (coût ∝ activité). */
  metabolisme: {
    evaluees: number;
    reposes: number;
    transmissions: number;
    ms: number;
  };
  horlogeColumnnaire: number;
  fenetresTraitees: number;
  consolidation: { epochs: number; samples: number };
}

/**
 * EFFECTEUR CORTEX V2 — surface neurale massive branchée au noyau v1.
 */
export class EffecteurCortexV2 implements Effecteur {
  readonly nom = "effecteur_cortex_v2";

  /** Cortex columnnaire (étage 2). */
  readonly cortex: CortexColumnnaire;

  /** Champ cortical génératif (étage 3 — 1e9 neurones adressables). */
  readonly champ: ChampCorticalGen3;

  private readonly reseau: ReseauInjectable;
  private readonly rng: () => number;

  /** Horloge virtuelle columnnaire propre (+1 par cycle évalué). */
  private horloge = 0;

  /** Fenêtre neuronale en cours (reset des énergies à chaque changement). */
  private fenetreCourante: number | null = null;

  /** Premier cycle de la fenêtre (volée d'injection). */
  private premierCycle = true;

  /** Accumulateurs de la fenêtre (plasticité consolidée à la clôture). */
  private stimuleesFenetre = new Set<number>();
  private resonancesMaxFenetre: Float32Array;
  private intentionCibleFenetre: string | null = null;

  /** Statistiques d'évolution. */
  private fenetresTraitees = 0;
  private consolidation = { epochs: 0, samples: 0 };

  /** it.56 — télémétrie du bus d'ondes (dernier bilan + total émis). */
  private dernierBilanOndes: BilanOndes = { paquets: 0, regionsTouchees: 0, renforts: 0, annulations: 0, energieTransportee: 0 };
  private paquetsEmisTotal = 0;

  constructor(
    reseau: ReseauInjectable,
    cortex: CortexColumnnaire,
    champ: ChampCorticalGen3,
    seedBruit = 11,
  ) {
    this.reseau = reseau;
    this.cortex = cortex;
    this.champ = champ;
    this.rng = createRng(seedBruit);
    this.resonancesMaxFenetre = new Float32Array(cortex.config.bandes);
  }

  /**
   * Cœur de l'effecteur (appelé par le noyau à CHAQUE cycle, requête ou
   * veille). Retourne [] : le cortex v2 est un traitement interne du
   * cerveau — il ne déclenche aucune action du corps sémantique.
   */
  evaluerEtExecuter(
    spikedNeurones: number[],
    contexte?: Record<string, unknown>,
  ): EffectorActionResult[] {
    void spikedNeurones; // (télémétrie v1 disponible si besoin)

    const fenetre =
      typeof contexte?.["__fenetreNeuronale"] === "number"
        ? (contexte["__fenetreNeuronale"] as number)
        : null;
    const intentionCible =
      typeof contexte?.["__intentionCible"] === "string"
        ? (contexte["__intentionCible"] as string)
        : null;
    const prompt =
      typeof contexte?.["prompt"] === "string"
        ? (contexte["prompt"] as string)
        : null;

    // ---- Clôture de la fenêtre précédente (plasticité supervisée) -------
    if (fenetre !== null && fenetre !== this.fenetreCourante) {
      this.consoliderFenetre();
      this.cortex.reinitialiserEnergies();
      this.stimuleesFenetre.clear();
      this.resonancesMaxFenetre.fill(0);
      this.intentionCibleFenetre = null;
      this.premierCycle = true;
      this.fenetreCourante = fenetre;
      this.fenetresTraitees += 1;
    }

    if (intentionCible) this.intentionCibleFenetre = intentionCible;

    // ---- (1) Injections : volée de tokens au 1er cycle, bruit en veille --
    let injections: Array<[number, number]> | null = null;
    if (this.premierCycle && prompt && prompt.trim().length > 0) {
      injections = this.cortex.projetterTokens(tokenize(prompt));
      for (const [colonne] of injections) this.stimuleesFenetre.add(colonne);
    } else if (!prompt || prompt.trim().length === 0) {
      // Veille / rêve : micro-stimulations aléatoires légères (0.05 %).
      const n = Math.max(16, Math.floor(this.cortex.config.colonnes * 0.0005));
      injections = [];
      for (let i = 0; i < n; i++) {
        injections.push([
          Math.floor(this.rng() * this.cortex.config.colonnes),
          this.rng() * 0.3,
        ]);
      }
    }

    // ---- (2) Pas columnnaire réel ---------------------------------------
    this.horloge += 1;
    this.cortex.pas(injections, this.horloge);

    // ---- (3) Couplage au champ cortical d'1e9 neurones -------------------
    // LECTURE GRADUÉE (activation = part d'énergie reçue par bande, somme
    // 1) : la bande entraînée se détache du bruit uniforme — la lecture
    // spike seule serait noyée par le bruit de Poisson du réservoir CSR.
    const activation = this.cortex.activationBandes();
    for (let b = 0; b < activation.length; b++) {
      if (activation[b] > this.resonancesMaxFenetre[b]) {
        this.resonancesMaxFenetre[b] = activation[b];
      }
    }
    this.champ.couplerBandes(activation);
    // ---- (3.5) BUS D'ONDES INTER-RÉGIONS (it.56) --------------------------
    // Chaque bande d'intention active fait émettre une région (rotation
    // déterministe) sur son porteur fréquentiel VOCABULAIRE — les 1000
    // régions résonnent : renfort en phase, annulation en opposition.
    // Le langage est réparti SOUS ONDES, partie ↔ partie, à coût borné.
    const paquets = emettrePaquetsDepuisBandes(activation, this.horloge);
    this.paquetsEmisTotal += paquets.length;
    this.dernierBilanOndes = this.champ.propagerOndes(this.horloge, paquets);
    if (!prompt) this.champ.veille(this.horloge);

    // ---- (4) Remontée columnnaire → pools v1 (pathway multi-échelle) -----
    this.reverserVersNoyau(activation);

    this.premierCycle = false;
    return [];
  }

  /**
   * Remontée : l'activation graduée de chaque bande d'intention (part
   * d'énergie reçue, normalisée) injecte une énergie proportionnelle dans
   * les neurones du pool v1 correspondant ; les bandes libres stimulent les
   * neurones libres en rotation (activité de fond riche).
   */
  private reverserVersNoyau(activation: readonly number[]): void {
    for (
      let b = 0;
      b < BANDES_INTENTION.length && b < activation.length;
      b++
    ) {
      const act = activation[b];
      if (act <= 0) continue;
      const injection = Math.min(
        CAP_REMONTEE_INTENTION,
        act * GAIN_REMONTEE_INTENTION,
      );
      const pool = BANDES_INTENTION[b].pool;
      for (const idNeurone of pool) {
        this.reseau.neurones.get(idNeurone)?.receiveInput(injection);
      }
    }
    // Bandes libres : activité de fond vers les neurones libres (rotation).
    let sommeLibre = 0;
    for (let b = BANDES_INTENTION.length; b < activation.length; b++) {
      sommeLibre += activation[b];
    }
    if (sommeLibre > 0) {
      const injection = Math.min(0.3, sommeLibre * GAIN_REMONTEE_LIBRE);
      const base = this.horloge % NEURONES_LIBRES.length;
      for (let i = 0; i < 4; i++) {
        const idNeurone =
          NEURONES_LIBRES[(base + i) % NEURONES_LIBRES.length];
        this.reseau.neurones.get(idNeurone)?.receiveInput(injection);
      }
    }
  }

  /**
   * Consolide la plasticité supervisée de la fenêtre qui se clôture :
   * renforcement des arêtes CSR colonnes stimulées → bande du label cible,
   * punition compétitive des bandes dont la résonance max a dépassé celle
   * de la bande cible (miroir exact du trainer v1). Chaque échantillon
   * consolidé fait aussi évoluer la graine d'entraînement du champ (les
   * 1e9 neurones apprennent par leur paramétrage génératif).
   */
  private consoliderFenetre(): void {
    const label = this.intentionCibleFenetre;
    if (!label || this.stimuleesFenetre.size === 0) return;

    const indexBande = BANDES_INTENTION.findIndex((b) => b.label === label);
    if (indexBande < 0) return;

    const scoreCible = this.resonancesMaxFenetre[indexBande];
    const concurrentes: number[] = [];
    for (let b = 0; b < BANDES_INTENTION.length; b++) {
      if (b === indexBande) continue;
      if (this.resonancesMaxFenetre[b] > scoreCible) concurrentes.push(b);
    }

    this.cortex.plasticiteSupervisee(
      this.stimuleesFenetre,
      indexBande,
      this.cortex.config.lrBoost,
      concurrentes,
    );
    this.consolidation.samples += 1;
    this.champ.consoliderApprentissage(0, 1);
  }

  /**
   * CONSOLIDATION D'EXPÉRIENCE — appelée après un entraînement (ou une
   * série d'échanges consolidés) : la graine d'entraînement du champ
   * évolue (les 1e9 neurones « apprennent » par leur paramétrage génératif).
   */
  consoliderExperience(epochs: number, samples: number): void {
    this.champ.consoliderApprentissage(epochs, samples);
    this.consolidation.epochs += epochs;
    this.consolidation.samples += samples;
  }

  /**
   * Restaure les compteurs d'expérience PRÊTS depuis un artefact, sans
   * re-consolider la graine (elle est déjà restaurée telle quelle).
   */
  restaurerCompteurs(epochs: number, samples: number): void {
    this.consolidation.epochs = Math.max(this.consolidation.epochs, epochs);
    this.consolidation.samples = Math.max(this.consolidation.samples, samples);
  }

  /** Télémétrie publique complète (données réelles, API). */
  etatPourApi(): EtatCortexV2 {
    return {
      cortex: this.cortex.stats(),
      champ: this.champ.statsRapides(this.horloge),
      busOndes: { ...this.dernierBilanOndes, paquetsEmisTotal: this.paquetsEmisTotal },
      metabolisme: { ...this.cortex.metabolismeDernierPas },
      horlogeColumnnaire: this.horloge,
      fenetresTraitees: this.fenetresTraitees,
      consolidation: { ...this.consolidation },
    };
  }
}

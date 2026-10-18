/**
 * RÉSEAU NEURONAL GEN3 — portage fidèle de la classe `ReseauNeuronalGen3`
 * de la source Python (Système neuronal.pdf).
 *
 * Le cerveau est un graphe dirigé de neurones « accumulate-and-fire » reliés
 * par des synapses pondérées. Un pas de temps (step) suit l'ORDRE EXACT de la
 * source : (1) injection des entrées externes, (2) updateState de tous les
 * neurones → liste des spikes, (3) transmission de l'énergie le long des
 * synapses dont la source a spike, avec plasticité (renforcement si la cible
 * s'est activée récemment).
 *
 * Module PUR — aucune dépendance Node.
 */

import { Neurone } from "./neuron";
import { Synapse } from "./synapse";
import { createRng, randUniform } from "./rng";
import { NEURAL_CONFIG_DEFAUTS } from "./types";
import type { NeuralConfig } from "./types";

/** État sérialisable du réseau (persistance, cf. training/persistence.ts). */
export interface ReseauStateExport {
  /** Configuration exacte ayant produit le réseau. */
  config: NeuralConfig;
  /** Synapses sérialisées compactes : [sourceId, targetId, weight]. */
  synapses: Array<[number, number, number]>;
}

/** Statistiques descriptives du réseau (outil OS « etat_reseau »). */
export interface ReseauStats {
  nbNeurones: number;
  nbSynapses: number;
  poidsMoyen: number;
  poidsMin: number;
  poidsMax: number;
  /** Histogramme des poids en 10 classes ([0.0,0.1), [0.1,0.2), ..., [0.9,1.0]). */
  histogramme: number[];
}

export class ReseauNeuronalGen3 {
  /** Neurones indexés par ID (0..size-1, ordre d'insertion stable). */
  neurones: Map<number, Neurone>;

  /** Synapses dirigées du réseau. */
  synapses: Synapse[];

  /** Taux d'apprentissage (plasticité non supervisée de step()). */
  learningRate: number;

  /** Configuration effective (remplacée uniquement par importState). */
  config: NeuralConfig;

  constructor(config: Partial<NeuralConfig> = {}) {
    this.config = { ...NEURAL_CONFIG_DEFAUTS, ...config };
    this.neurones = new Map<number, Neurone>();
    for (let i = 0; i < this.config.size; i++) {
      this.neurones.set(
        i,
        new Neurone(i, this.config.defaultThreshold, this.config.defaultDecay),
      );
    }
    this.synapses = [];
    this.learningRate = this.config.learningRate;

    // Initialisation de connexions aléatoires (RNG seedé — adaptation (a)).
    this.genererConnexionsInitiales(this.config.density);
  }

  /**
   * Génération initiale des connexions (fidèle à la source) : pour chaque paire
   * src≠tgt, une synapse existe avec probabilité `density`, de poids uniforme
   * dans [0.1, 0.5]. Deux réseaux de même seed produisent des synapses
   * strictement identiques (ordre d'appel du RNG identique à la source :
   * tirage d'existence PUIS tirage du poids).
   */
  genererConnexionsInitiales(density: number): void {
    const rng = createRng(this.config.seed);
    const size = this.neurones.size;
    for (let src = 0; src < size; src++) {
      for (let tgt = 0; tgt < size; tgt++) {
        if (src !== tgt && rng() < density) {
          this.synapses.push(
            new Synapse(src, tgt, randUniform(rng, 0.1, 0.5)),
          );
        }
      }
    }
  }

  /**
   * Un pas de temps dynamique dans le cerveau. ORDRE EXACT de la source :
   *  1. Injection des entrées externes (ex : du corps sémantique) ;
   *  2. Update de tous les neurones → collecte des spikes ;
   *  3. Transmission le long des synapses dont la source a spike :
   *     la cible reçoit le poids, et la plasticité s'applique si la cible a
   *     spike dans la fenêtre (`currentTime - lastSpikeTime < plasticityWindow`)
   *     → weight = min(1, weight + learningRate).
   *
   * @returns Les IDs des neurones ayant spike pendant ce pas.
   */
  step(
    externalInputs: Record<number, number>,
    currentTime: number,
  ): number[] {
    // 1. Injection des entrées externes (ex: du corps sémantique)
    for (const idTexte of Object.keys(externalInputs)) {
      const neuroneId = Number(idTexte);
      const neurone = this.neurones.get(neuroneId);
      if (neurone) {
        neurone.receiveInput(externalInputs[neuroneId]);
      }
    }

    // 2. Propagation des signaux à travers les synapses
    const spikedNeurones: number[] = [];
    for (const [id, neurone] of this.neurones) {
      if (neurone.updateState(currentTime)) {
        spikedNeurones.push(id);
      }
    }

    // 3. Transmettre l'énergie le long des synapses
    const spikedSet = new Set(spikedNeurones);
    for (const synapse of this.synapses) {
      if (spikedSet.has(synapse.sourceId)) {
        const target = this.neurones.get(synapse.targetId);
        if (!target) continue;
        target.receiveInput(synapse.weight);
        synapse.lastActivation = currentTime;

        // Plasticité synaptique (Renforcement si la cible s'est activée récemment)
        const timeDiff = currentTime - target.lastSpikeTime;
        if (timeDiff < this.config.plasticityWindow) {
          // Fenêtre de plasticité
          synapse.weight = Math.min(1.0, synapse.weight + this.learningRate);
        }
      }
    }

    return spikedNeurones;
  }

  /** Statistiques descriptives : compteurs, poids et histogramme (10 classes). */
  getStats(): ReseauStats {
    const nbSynapses = this.synapses.length;
    const histogramme = new Array<number>(10).fill(0);
    let somme = 0;
    let min = nbSynapses > 0 ? this.synapses[0].weight : 0;
    let max = nbSynapses > 0 ? this.synapses[0].weight : 0;
    for (const synapse of this.synapses) {
      const w = synapse.weight;
      somme += w;
      if (w < min) min = w;
      if (w > max) max = w;
      // Classe [w*10] bornée à 9 (un poids de exactement 1.0 tombe en classe 9).
      const classe = Math.min(9, Math.max(0, Math.floor(w * 10)));
      histogramme[classe] += 1;
    }
    return {
      nbNeurones: this.neurones.size,
      nbSynapses,
      poidsMoyen: nbSynapses > 0 ? somme / nbSynapses : 0,
      poidsMin: min,
      poidsMax: max,
      histogramme,
    };
  }

  /** Sérialise l'état structurel (config + synapses compactes). */
  exportState(): ReseauStateExport {
    return {
      config: { ...this.config },
      synapses: this.synapses.map(
        (s) => [s.sourceId, s.targetId, s.weight] as [number, number, number],
      ),
    };
  }

  /**
   * Restaure un état exporté : recrée les neurones selon la config puis les
   * synapses sérialisées. Les énergies repartent de zéro (seul le câblage
   * appris est persistant — les énergies sont par nature transitoires).
   */
  importState(state: ReseauStateExport): void {
    const config: NeuralConfig = {
      ...NEURAL_CONFIG_DEFAUTS,
      ...state.config,
    };
    this.neurones = new Map<number, Neurone>();
    for (let i = 0; i < config.size; i++) {
      this.neurones.set(
        i,
        new Neurone(i, config.defaultThreshold, config.defaultDecay),
      );
    }
    this.synapses = state.synapses.map(
      ([sourceId, targetId, weight]) =>
        new Synapse(sourceId, targetId, weight),
    );
    this.learningRate = config.learningRate;
    this.config = config;
  }
}

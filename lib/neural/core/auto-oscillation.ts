/**
 * GÉNÉRATEUR D'AUTO-OSCILLATION — portage fidèle de la classe
 * `GenerateurAutoOscillation` de la source Python (Module d'Auto-Oscillation.pdf).
 *
 * Génère une activité interne autonome lorsque le système est inactif :
 * micro-stimulations aléatoires (bruit métabolique) puis propagation interne.
 * Permet au réseau de « rêver » et de faire circuler l'information en boucle
 * fermée. Le bruit est issu du RNG seedé (adaptation (a) : reproductibilité).
 *
 * Module PUR — aucune dépendance Node.
 */

import { createRng, randUniform } from "./rng";
import type { ReseauNeuronalGen3 } from "./network";

/** Graine par défaut du bruit de fond si aucun RNG n'est fourni. */
export const SEED_AUTO_OSCILLATION_DEFAUT = 7;

export class GenerateurAutoOscillation {
  /** Réseau neuronal stimulé. */
  readonly reseau: ReseauNeuronalGen3;

  /** Intensité du bruit de fond (amplitude max d'une micro-stimulation). */
  noiseIntensity: number;

  /** Probabilité qu'un neurone subisse une impulsion spontanée. */
  spontaneityRate: number;

  /** Générateur déterministe partagé (adaptation (a)). */
  private rng: () => number;

  constructor(
    reseau: ReseauNeuronalGen3,
    noiseIntensity = 0.15,
    spontaneityRate = 0.15,
    rng: () => number = createRng(SEED_AUTO_OSCILLATION_DEFAUT),
  ) {
    this.reseau = reseau;
    this.noiseIntensity = noiseIntensity; // Intensité du bruit de fond
    this.spontaneityRate = spontaneityRate; // Probabilité d'impulsion spontanée
    this.rng = rng;
  }

  /**
   * Génère une activité interne autonome (veille / rêve continu) :
   *  1. Injection de micro-stimulations aléatoires sur l'ensemble du réseau ;
   *  2. Exécution d'un pas de propagation interne sans entrée utilisateur.
   *
   * @returns Les IDs des neurones ayant spike.
   */
  simulerVeille(currentTime: number): number[] {
    // 1. Injection de micro-stimulations aléatoires sur l'ensemble du réseau
    for (const neurone of this.reseau.neurones.values()) {
      if (this.rng() < this.spontaneityRate) {
        // Impulsion de fond pour simuler l'activité métabolique/neuronale
        // spontanée.
        neurone.receiveInput(randUniform(this.rng, 0.0, this.noiseIntensity));
      }
    }

    // 2. Exécution d'un pas de propagation interne sans entrée utilisateur
    const spikedNeurons = this.reseau.step({}, currentTime);

    return spikedNeurons;
  }
}

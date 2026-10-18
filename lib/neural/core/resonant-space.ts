/**
 * ESPACE D'ENTRÉE-SORTIE RÉSONANT — portage fidèle de la classe
 * `EspaceFiltreResonant` de la source Python (Espace d'entrée-sortie.pdf).
 *
 * Fait le pont entre les canaux sémantiques du corps et les IDs de neurones
 * du noyau : un signal entrant (canal) est converti en énergie neuronale, et
 * la résonance d'un pool de sortie (fraction de ses neurones ayant spike)
 * est lue à chaque cycle par les effecteurs pour décider d'agir.
 *
 * Module PUR — aucune dépendance Node.
 */

import type { ReseauNeuronalGen3 } from "./network";

export class EspaceFiltreResonant {
  /**
   * Mappages entre les canaux d'ENTRÉE du corps sémantique et les IDs des
   * neurones du noyau. Ex : { "utilisateur_in": [38, 39] }.
   */
  inputPools: Map<string, number[]>;

  /**
   * Mappages entre les canaux de SORTIE et les IDs des neurones du noyau.
   * Ex : { "SYSTEM_ACTION": [96, 97, 98, 99] }.
   */
  outputPools: Map<string, number[]>;

  constructor() {
    this.inputPools = new Map<string, number[]>();
    this.outputPools = new Map<string, number[]>();
  }

  /** Enregistre un pool d'entrée (canal → IDs de neurones). */
  registerInputPool(canal: string, neuroneIds: number[]): void {
    this.inputPools.set(canal, neuroneIds);
  }

  /** Enregistre un pool de sortie (canal → IDs de neurones). */
  registerOutputPool(canal: string, neuroneIds: number[]): void {
    this.outputPools.set(canal, neuroneIds);
  }

  /**
   * Convertit un signal du corps sémantique en énergie neuronale stimulante :
   * chaque neurone du pool du canal reçoit l'intensité (injection modulée
   * par résonance, cf. source). Canal inconnu → aucune injection.
   */
  injectSignal(
    reseau: ReseauNeuronalGen3,
    canal: string,
    intensity: number,
  ): void {
    const pool = this.inputPools.get(canal);
    if (!pool) return;
    for (const nId of pool) {
      const neurone = reseau.neurones.get(nId);
      if (neurone) {
        neurone.receiveInput(intensity);
      }
    }
  }

  /**
   * Mesure le niveau de résonance (taux d'activation) d'un groupe de sortie :
   * nombre de neurones du pool ayant spike ce cycle / taille du pool.
   * Pool inconnu ou vide → 0.0 (comme la source).
   */
  readResonance(spikedNeurones: number[], canal: string): number {
    const targetIds = this.outputPools.get(canal);
    if (!targetIds || targetIds.length === 0) return 0.0;

    const spikedSet = new Set(spikedNeurones);
    // Compte combien de neurones de la zone ont tiré lors de ce cycle
    let matches = 0;
    for (const nId of targetIds) {
      if (spikedSet.has(nId)) matches += 1;
    }
    return matches / targetIds.length;
  }
}

/**
 * NEURONE — portage fidèle de la classe `Neurone` de la source Python
 * (Système neuronal.pdf, cf. scripts/neural_reference/core_reference.py).
 *
 * Modèle « accumulate-and-fire » : l'énergie s'accumule via receiveInput(),
 * décroît naturellement à chaque updateState() (homéostasie locale) et le
 * passage du seuil provoque un spike suivi d'une réinitialisation à zéro.
 *
 * Module PUR — aucune dépendance Node.
 */

/** Historique d'état borné (adaptation : la liste Python existait mais restait vide ; on la remplit réellement, bornée à 50 snapshots). */
export const TAILLE_HISTORIQUE_ETAT = 50;

export class Neurone {
  /** Identifiant unique dans le réseau. */
  readonly id: number;

  /** Énergie courante du neurone (0 après un spike). */
  energy: number;

  /** Seuil de déclenchement (spike) quand l'énergie l'atteint ou le dépasse. */
  threshold: number;

  /** Perte naturelle d'énergie au fil du temps (fraction par pas). */
  decay: number;

  /** Temps (horloge virtuelle) du dernier spike — pivot de la plasticité. */
  lastSpikeTime: number;

  /**
   * Historique borné des niveaux d'énergie observés à chaque updateState().
   * (Adaptation mineure documentée : la source déclarait `state_history = []`
   * sans jamais l'alimenter ; on y enregistre l'énergie post-décroissance,
   * plafonnée à 50 valeurs.)
   */
  stateHistory: number[];

  constructor(
    neuroneId: number,
    threshold = 1.0,
    decay = 0.1,
  ) {
    this.id = neuroneId;
    this.energy = 0.0;
    this.threshold = threshold;
    this.decay = decay; // Perte naturelle d'énergie au fil du temps
    this.lastSpikeTime = 0;
    this.stateHistory = [];
  }

  /** Accumule une entrée d'énergie (stimulation externe ou synaptique). */
  receiveInput(value: number): void {
    this.energy += value;
  }

  /**
   * Un pas de temps local du neurone : décroissance naturelle puis test du
   * seuil. Retourne true si le neurone a spike (l'énergie est alors remise à
   * zéro et l'heure du spike enregistrée).
   *
   * LOGIQUE EXACTE de la source : décroissance PUIS vérification du seuil
   * (`>=`), réinitialisation après déclenchement.
   */
  updateState(currentTime: number): boolean {
    // Dissipation naturelle de l'énergie (Homéostasie locale)
    this.energy *= 1.0 - this.decay;

    // Historique borné de l'état post-décroissance.
    this.stateHistory.push(this.energy);
    if (this.stateHistory.length > TAILLE_HISTORIQUE_ETAT) {
      this.stateHistory.shift();
    }

    // Vérification du seuil de déclenchement (Spike)
    if (this.energy >= this.threshold) {
      this.energy = 0.0; // Réinitialisation après déclenchement
      this.lastSpikeTime = currentTime;
      return true;
    }
    return false;
  }
}

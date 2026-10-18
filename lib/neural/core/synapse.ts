/**
 * SYNAPSE — portage fidèle de la classe `Synapse` de la source Python.
 *
 * Connexion orientée source → cible portant un poids : quand la source spike,
 * la cible reçoit `weight` unités d'énergie. `lastActivation` est conservé
 * comme dans la source (mis à jour à chaque transmission effective).
 *
 * Module PUR — aucune dépendance Node.
 */
export class Synapse {
  /** ID du neurone source (pré-synaptique). */
  readonly sourceId: number;

  /** ID du neurone cible (post-synaptique). */
  readonly targetId: number;

  /** Poids de la connexion (0..1 après plasticité). */
  weight: number;

  /** Temps (horloge virtuelle) de la dernière transmission. */
  lastActivation: number;

  constructor(sourceId: number, targetId: number, weight = 0.5) {
    this.sourceId = sourceId;
    this.targetId = targetId;
    this.weight = weight;
    this.lastActivation = 0;
  }
}

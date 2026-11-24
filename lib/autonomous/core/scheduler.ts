/**
 * SCHEDULER DU GEN3IA AUTONOMOUS CORE (Phase 1).
 *
 * Rythme de base du plan : un CYCLE toutes les 5 minutes (configurable).
 * Le scheduler ne fait QUE battre la mesure : il déclenche le callback de
 * cycle sans l'attendre — « les cycles ne dépendent pas du traitement des
 * cycles précédents » (contrainte n°1 du plan). Le cycle 1 part immédiatement
 * au démarrage, puis chaque intervalle.
 */

/** Minuterie du heartbeat — un seul timer Node pour tout le core (RAM). */
export class PlanificateurCycles {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cycle = 0;

  constructor(
    private readonly intervalleMs: number,
    private readonly onCycle: (cycle: number) => void,
  ) {}

  /** Le core tourne-t-il ? */
  actif(): boolean {
    return this.timer !== null;
  }

  /** Cycle courant (dernier déclenché). */
  cycleCourant(): number {
    return this.cycle;
  }

  /**
   * Démarre le heartbeat : cycle immédiat (non bloquant), puis un cycle par
   * intervalle. Idempotent : un scheduler déjà actif ne double pas.
   * `cycleInitial` : compteur restauré après redémarrage (le plan impose la
   * reprise des opérations interrompues — les cycles reprennent leur suite,
   * ils ne repartent pas de 1).
   */
  demarrer(cycleInitial = 0): boolean {
    if (this.timer) return false;
    this.cycle = Math.max(0, Math.floor(cycleInitial));
    this.timer = setInterval(() => {
      this.cycle += 1;
      try {
        this.onCycle(this.cycle);
      } catch {
        /* le heartbeat ne meurt jamais sur une erreur de callback. */
      }
    }, this.intervalleMs);
    // Le timer Node garde le process vivant — le core tourne en arrière-plan
    // sans empêcher un arrêt propre via arreter().
    if (typeof this.timer.unref === "function") this.timer.unref();
    this.cycle += 1;
    try {
      this.onCycle(this.cycle);
    } catch {
      /* idem — le premier cycle est supervisé par l'orchestrator. */
    }
    return true;
  }

  /** Arrête le heartbeat (arrêt propre — les ticks déjà lancés se terminent). */
  arreter(): boolean {
    if (!this.timer) return false;
    clearInterval(this.timer);
    this.timer = null;
    return true;
  }
}

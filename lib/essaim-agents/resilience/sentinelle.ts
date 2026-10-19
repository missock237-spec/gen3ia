/**
 * Résilience par « Résonance de Phase » — l'auto-guérison de l'essaim.
 *
 * Inspirée des systèmes biologiques : chaque nœud émet une onde de vie
 * (battement) dont l'AMPLITUDE porte sa santé. La sentinelle observe
 * ces amplitudes ; si une amplitude chute sous le seuil (navigateur
 * fermé brutalement, onglet planté, réseau coupé) ou si le signal se
 * tait, l'onde est déclarée ROMPUE — et les tâches qu'elle portait,
 * orphelines, sont immédiatement ré-attribuées à un autre nœud
 * disponible, en quelques millisecondes, de manière transparente pour
 * l'utilisateur.
 *
 * Le journal de résonance consigne chaque rupture, chaque ré-attribution
 * et chaque recouvrement : la guérison est visible, jamais silencieuse.
 */

import type { OrchestrateurAgents } from "../orchestrateur";
import type { EvenementResilience } from "../types";
import { BORNES_AGENTS } from "../types";

/** Historique d'amplitude conservé par nœud (courbe de résonance). */
export interface TraceAmplitude {
  noeud: string;
  /** Dernières amplitudes observées (la plus récente en fin). */
  amplitudes: number[];
  dernierBattement: number;
  /** En rupture ? (le nœud était vivant, son onde a chuté) */
  rompu: boolean;
}

export interface OptionsSentinelle {
  orchestrateur: OrchestrateurAgents;
  /** Période de vérification (ms, défaut 2000). */
  periodeVerification?: number;
  /** Multiplicateur de silence toléré (défaut 2.5 × période battement). */
  multiplicateurSilence?: number;
}

function nouvelEvenementId(): string {
  return `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SentinelleResilience {
  private readonly orchestrateur: OrchestrateurAgents;
  private readonly periodeVerification: number;
  private readonly multiplicateurSilence: number;

  private traces = new Map<string, TraceAmplitude>();
  private journal: EvenementResilience[] = [];
  private minuterie: ReturnType<typeof setInterval> | null = null;

  constructor(options: OptionsSentinelle) {
    this.orchestrateur = options.orchestrateur;
    this.periodeVerification = options.periodeVerification ?? 2000;
    this.multiplicateurSilence = options.multiplicateurSilence ?? 2.5;
  }

  /* ---------------------------- observation ----------------------- */

  /**
   * Observe l'amplitude d'un nœud (appelé à chaque onde de vie reçue).
   * Un nœud rompu qui revient avec une amplitude saine = recouvrement.
   */
  observer(noeud: string, amplitude: number, ts: number = Date.now()): void {
    let trace = this.traces.get(noeud);
    if (!trace) {
      trace = { noeud, amplitudes: [], dernierBattement: ts, rompu: false };
      this.traces.set(noeud, trace);
    }
    trace.amplitudes.push(amplitude);
    if (trace.amplitudes.length > 32) trace.amplitudes = trace.amplitudes.slice(-16);
    trace.dernierBattement = ts;

    if (trace.rompu && amplitude >= BORNES_AGENTS.seuilAmplitude) {
      trace.rompu = false;
      this.consigner({
        type: "recouvrement",
        noeudRelais: noeud,
        amplitude,
        detail: `Résonance rétablie avec ${noeud.slice(0, 8)}… (amplitude ${amplitude.toFixed(2)}) — le nœud revient dans la phase.`,
      });
    }
  }

  /**
   * Vérifie toutes les ondes de vie : amplitude sous le seuil ou silence
   * trop long ⇒ rupture ⇒ ré-attribution immédiate des tâches orphelines
   * via l'orchestrateur (qui distribue le SOS).
   */
  verifier(maintenant: number = Date.now()): EvenementResilience[] {
    const evenementsLocaux: EvenementResilience[] = [];
    const silenceTolere = BORNES_AGENTS.periodeBattement * this.multiplicateurSilence;

    for (const trace of this.traces.values()) {
      const amplitude = trace.amplitudes[trace.amplitudes.length - 1] ?? 0;
      const silence = maintenant - trace.dernierBattement;
      if (trace.rompu) continue;

      const chute = amplitude < BORNES_AGENTS.seuilAmplitude;
      const muet = silence > silenceTolere;
      if (!chute && !muet) continue;

      trace.rompu = true;
      this.consigner({
        type: "rupture",
        noeudPerdu: trace.noeud,
        amplitude,
        detail: muet
          ? `Onde de vie perdue : ${trace.noeud.slice(0, 8)}… silencieux depuis ${(silence / 1000).toFixed(1)} s — rupture de phase détectée.`
          : `Chute d'amplitude de ${trace.noeud.slice(0, 8)}… (${amplitude.toFixed(2)} < ${BORNES_AGENTS.seuilAmplitude}) — rupture de phase détectée.`,
      });

      // Ré-attribution immédiate des ondes orphelines portées par ce nœud.
      const perdues = this.orchestrateur.signalerRupture(trace.noeud);
      for (const tache of perdues) {
        this.consigner({
          type: "reattribution",
          tacheId: tache.id,
          noeudPerdu: trace.noeud,
          detail: `Onde orpheline (${tache.type} ${tache.id.slice(-6)}) ré-attribuée à l'essaim immédiatement — transparent pour l'utilisateur.`,
        });
      }
      evenementsLocaux.push({
        id: nouvelEvenementId(),
        ts: maintenant,
        type: "rupture",
        noeudPerdu: trace.noeud,
        amplitude,
        detail: `Nœud ${trace.noeud} hors phase.`,
      });
    }
    return evenementsLocaux;
  }

  /** Alimente la sentinelle depuis la table des nœuds de l'orchestrateur. */
  observerDepuisOrchestrateur(): void {
    for (const noeud of this.orchestrateur.noeudsConnus) {
      // PAS de filtre sur les nœuds rompus : observer() gère lui-même le
      // recouvrement — un nœud guéri doit pouvoir revenir en phase.
      this.observer(noeud.id, noeud.amplitude, noeud.dernierBattement);
    }
  }

  /* ---------------------------- cycle de vie ---------------------- */

  demarrer(): void {
    if (this.minuterie) return;
    this.minuterie = setInterval(() => {
      this.observerDepuisOrchestrateur();
      this.verifier();
    }, this.periodeVerification);
  }

  arreter(): void {
    if (this.minuterie) clearInterval(this.minuterie);
    this.minuterie = null;
  }

  /* ---------------------------- journal --------------------------- */

  private consigner(
    evenement: Omit<EvenementResilience, "id" | "ts">,
  ): void {
    this.journal.push({ id: nouvelEvenementId(), ts: Date.now(), ...evenement });
    if (this.journal.length > 256) this.journal = this.journal.slice(-128);
  }

  get evenements(): EvenementResilience[] {
    return [...this.journal].reverse(); // le plus récent en premier
  }

  /** Courbes d'amplitude par nœud (visualisation de la résonance). */
  get tracesAmplitude(): TraceAmplitude[] {
    return [...this.traces.values()];
  }

  get statistiques(): { ruptures: number; reattributions: number; recouvrements: number; nœudsSuivis: number } {
    return {
      ruptures: this.journal.filter((e) => e.type === "rupture").length,
      reattributions: this.journal.filter((e) => e.type === "reattribution").length,
      recouvrements: this.journal.filter((e) => e.type === "recouvrement").length,
      nœudsSuivis: this.traces.size,
    };
  }

  /**
   * Simulation pédagogique : force une chute d'amplitude d'un nœud
   * (utilisé par la console pour DÉMONTRER l'auto-réparation en direct).
   * Le nœud doit être connu de la sentinelle (au moins un battement reçu).
   */
  simulerRupture(noeud: string): EvenementResilience[] {
    const trace = this.traces.get(noeud);
    if (!trace) return [];
    trace.amplitudes.push(0.02); // onde effondrée
    trace.dernierBattement = Date.now() - BORNES_AGENTS.periodeBattement * 4;
    return this.verifier();
  }
}

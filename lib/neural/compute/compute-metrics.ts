/**
 * COMPUTE METRICS — mesures réelles des exécutions (mission Phase 9/11) :
 * compteurs par moteur, fallbacks, durées p50/p95 calculées sur échantillon
 * borné. Aucune estimation présentée comme mesure — l'énergie estime
 * explicitement sa nature ("estimee") tant qu'aucun compteur matériel
 * n'expose les joules.
 */

import type { MesureCalcul, MoteurCalcul } from "./compute-types";

const ECHANTILLON_MAX = 500;

export interface InstantaneMetrics {
  parMoteur: Record<MoteurCalcul, number>;
  fallbacks: number;
  executions: number;
  dureeMoyenneMs: number;
  dureeP50Ms: number;
  dureeP95Ms: number;
  /** Dernières mesures bornées (dashboard historique). */
  recentes: MesureCalcul[];
}

export class RegistreMetrics {
  private mesures: MesureCalcul[] = [];
  private parMoteur: Record<MoteurCalcul, number> = { cpu: 0, webgpu: 0, hybride: 0 };
  private fallbacks = 0;

  enregistrer(m: MesureCalcul): void {
    this.mesures.push(m);
    if (this.mesures.length > ECHANTILLON_MAX) this.mesures.shift();
    this.parMoteur[m.moteur]++;
    if (m.fallback) this.fallbacks++;
  }

  instantane(): InstantaneMetrics {
    const durees = this.mesures.map((m) => m.dureeMs).sort((a, b) => a - b);
    const moyenne = durees.length ? durees.reduce((a, b) => a + b, 0) / durees.length : 0;
    const quantile = (q: number) => (durees.length ? durees[Math.max(0, Math.min(durees.length - 1, Math.ceil(q * durees.length) - 1))] : 0);
    return {
      parMoteur: { ...this.parMoteur },
      fallbacks: this.fallbacks,
      executions: this.mesures.length,
      dureeMoyenneMs: Math.round(moyenne * 100) / 100,
      dureeP50Ms: quantile(0.5),
      dureeP95Ms: quantile(0.95),
      recentes: this.mesures.slice(-10),
    };
  }

  reinitialiser(): void {
    this.mesures = [];
    this.parMoteur = { cpu: 0, webgpu: 0, hybride: 0 };
    this.fallbacks = 0;
  }
}

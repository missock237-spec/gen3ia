/**
 * ERROR-MONITOR DU GEN3IA AUTONOMOUS CORE (Phase 1).
 *
 * Anneau borné des dernières erreurs PAR module-agent + calcul du taux
 * d'erreur réel. Aucune erreur n'est inventée ni masquée : les messages
 * proviennent exclusivement des captures du process-manager.
 */

import type { EtatModule } from "../core/types";

/** Taille de l'anneau des dernières erreurs par module. */
export const MAX_ERREURS_RECENTES = 5;

/** Enregistre une erreur dans l'anneau borné du module (la plus récente d'abord). */
export function enregistrerErreur(etat: EtatModule, message: string): void {
  etat.dernieresErreurs.unshift(`${new Date().toISOString()} — ${message}`);
  if (etat.dernieresErreurs.length > MAX_ERREURS_RECENTES) {
    etat.dernieresErreurs.length = MAX_ERREURS_RECENTES;
  }
}

/** Taux d'erreur réel du module (0..1 ; 0 sans mesure). */
export function tauxErreur(ticks: number, echecs: number): number {
  if (ticks <= 0) return 0;
  return Math.min(1, echecs / ticks);
}

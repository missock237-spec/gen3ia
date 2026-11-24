/**
 * RECOVERY-MANAGER DU GEN3IA AUTONOMOUS CORE (Phase 1).
 *
 * Politique de survie d'un module-agent : après N échecs consécutifs, le
 * module est SUSPENDU (avec cause tracée) puis RÉARMÉ automatiquement après
 * la durée de suspension — jamais retiré du registre, jamais redémarré en
 * boucle serrée (backoff par la suspension). Une panne d'un module ne
 * bloque jamais les autres : la suspension est par-module.
 */

import type { EtatModule } from "../core/types";

/** Le module est-il suspendu à la date donnée ? */
export function estSuspendu(etat: EtatModule, maintenantMs: number): boolean {
  if (etat.statut !== "suspendu" || !etat.suspenduJusquA) return false;
  return Date.parse(etat.suspenduJusquA) > maintenantMs;
}

/** Suspend le module si le seuil d'échecs consécutifs est atteint. */
export function suspendreSiNecessaire(
  etat: EtatModule,
  echecsAvantSuspension: number,
  suspensionMs: number,
  maintenantMs: number,
): void {
  if (etat.echecsConsecutifs < echecsAvantSuspension) return;
  etat.statut = "suspendu";
  etat.suspenduJusquA = new Date(maintenantMs + suspensionMs).toISOString();
  etat.suspenduRaison = `${etat.echecsConsecutifs} échecs consécutifs`;
}

/** Réarme le module si la suspension a expiré (reprise automatique). */
export function rearmementSiExpiré(
  etat: EtatModule,
  suspensionMs: number,
  maintenantMs: number,
): void {
  if (etat.statut !== "suspendu" || !etat.suspenduJusquA) return;
  if (Date.parse(etat.suspenduJusquA) <= maintenantMs) {
    etat.statut = "actif";
    etat.suspenduJusquA = undefined;
    etat.suspenduRaison = undefined;
    // Le compteur consécutif repart à zéro : le module a eu sa pause.
    etat.echecsConsecutifs = 0;
    etat.dernierMessage = "Réarmé automatiquement après suspension";
    void suspensionMs;
  }
}

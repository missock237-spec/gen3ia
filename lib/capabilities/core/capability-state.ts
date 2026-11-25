/**
 * MACHINE À ÉTATS DES CAPACITÉS — transitions autorisées entre statuts UCE.
 *
 * Garanties mission UCE :
 *  - aucune capacité n'est « intégrée » sans passer par « autorisee »
 *    (autorisation explicite, défaut OFF — voir permission-manager) ;
 *  - aucune capacité n'est « validee » sans preuve de vérification réelle ;
 *  - tout retour en arrière passe par le statut « rollback » (traçable).
 */

import type { CapabilityStatus } from "./capability-contract";

/** Transitions autorisées : statut courant → statuts cibles possibles. */
export const TRANSITIONS_AUTORISEES: Record<CapabilityStatus, CapabilityStatus[]> = {
  decouverte: ["evaluee", "rejetee"],
  evaluee: ["benchmarquee", "proposee", "rejetee", "suspendue"],
  benchmarquee: ["proposee", "rejetee", "suspendue"],
  proposee: ["autorisee", "rejetee", "suspendue"],
  autorisee: ["integree", "suspendue", "rejetee"],
  integree: ["validee", "rollback", "suspendue"],
  validee: ["rollback", "suspendue"],
  rejetee: ["decouverte"],
  suspendue: ["evaluee", "rejetee"],
  rollback: ["proposee", "rejetee"],
};

/** Raison d'un refus de transition (message honnête pour audit). */
export interface DecisionTransition {
  ok: boolean;
  raison: string;
}

/**
 * Vérifie qu'une transition de statut est autorisée. Ne mute rien : le
 * gestionnaire de capacités applique la décision après contrôle.
 */
export function verifierTransition(depuis: CapabilityStatus, vers: CapabilityStatus): DecisionTransition {
  if (depuis === vers) return { ok: false, raison: "statut identique : transition inutile" };
  const cibles = TRANSITIONS_AUTORISEES[depuis] ?? [];
  if (!cibles.includes(vers)) {
    return {
      ok: false,
      raison: `transition interdite : ${depuis} → ${vers} (autorisées : ${cibles.join(", ")})`,
    };
  }
  return { ok: true, raison: `${depuis} → ${vers}` };
}

/**
 * EXECUTION LOGGER (UCE) — journaux structurés, bornés et SANS SECRET.
 * Chaque exécution du gateway accumulate ses journaux ici ; rien n'est
 * persisté sans passer par `sanitiserTexte` (secrets-protection).
 */

import "server-only";

import { sanitiserTexte } from "../security/secrets-protection";

const PLAFOND_LIGNES = 100;

export class JournalExecution {
  private lignes: string[] = [];
  private readonly debutMs = Date.now();

  /** Horodate + message masqué + tronqué. */
  ajouter(message: string): void {
    if (this.lignes.length >= PLAFOND_LIGNES) {
      if (!this.lignes.some((l) => l.includes("[journal tronqué]"))) {
        this.lignes.push("[journal tronqué] lignes suivantes ignorées");
      }
      return;
    }
    const ms = Date.now() - this.debutMs;
    const propre = sanitiserTexte(message, 500).texte;
    this.lignes.push(`+${ms}ms ${propre}`);
  }

  /** Récupère les lignes (copie) pour l'enregistrement d'exécution. */
  lignesActuelles(): string[] {
    return [...this.lignes];
  }
}

/** Journal trivial pour les appels sans objet (fonctions pures). */
export function journalSimple(messages: string[]): string[] {
  return messages.map((m) => sanitiserTexte(m, 500).texte).slice(0, PLAFOND_LIGNES);
}

/**
 * EXECUTION LOGGER (UCE) — journaux structurés, bornés et SANS SECRET.
 * Chaque exécution du gateway accumulate ses journaux ici ; rien n'est
 * persisté sans passer par `sanitiserTexte` (secrets-protection).
 */

import "server-only";

import { sanitiserTexte } from "../security/secrets-protection";

const PLAFOND_LIGNES = 100;

export class JournalExecution {
  private tampon: string[] = [];
  private readonly debutMs = Date.now();

  /** Horodate + message masqué + tronqué. */
  ajouter(message: string): void {
    if (this.tampon.length >= PLAFOND_LIGNES) {
      if (!this.tampon.some((l) => l.includes("[journal tronqué]"))) {
        this.tampon.push("[journal tronqué] lignes suivantes ignorées");
      }
      return;
    }
    const ms = Date.now() - this.debutMs;
    const propre = sanitiserTexte(message, 500).texte;
    this.tampon.push(`+${ms}ms ${propre}`);
  }

  /** Récupère les lignes (copie) pour l'enregistrement d'exécution. */
  lignesActuelles(): string[] {
    return [...this.tampon];
  }

  /** Alias court (contrat tests/consommateurs). */
  lignes(): string[] {
    return this.lignesActuelles();
  }
}

/** Journal trivial pour les appels sans objet (fonctions pures). */
export function journalSimple(messages: string[]): string[] {
  return messages.map((m) => sanitiserTexte(m, 500).texte).slice(0, PLAFOND_LIGNES);
}

/**
 * EVENT ORDERING — ordre GARANTI des événements par session (critère LOT 2 :
 * « les participants reçoivent les événements dans le bon ordre »). Le bus
 * numérote monotoniquement chaque événement par session (séquence) ; le
 * récepteur détecte les trous (perte WebSocket) et demande une reprise
 * (rattrapage par historique). Déterministe et testable : aucune magie.
 */

export interface EvenementNumerote {
  sequence: number;
  sessionId: string;
  type: string;
  horodatage: number;
}

/** Numéroteur monotonique par session (côté émission). */
export class NumeroteurEvenements {
  private compteurs = new Map<string, number>();

  numeroter(sessionId: string, type: string, horodatage = Date.now()): EvenementNumerote {
    const suivant = (this.compteurs.get(sessionId) ?? 0) + 1;
    this.compteurs.set(sessionId, suivant);
    return { sequence: suivant, sessionId, type, horodatage };
  }

  dernier(sessionId: string): number {
    return this.compteurs.get(sessionId) ?? 0;
  }
}

export type DiagnosticReception =
  | { etat: "en-ordre"; attendu: number; recu: number }
  | { etat: "trou-detected"; attendu: number; recu: number; manquants: number[] }
  | { etat: "doublon"; attendu: number; recu: number };

/**
 * Récepteur : vérifie la continuité des séquences par session. Un trou →
 * liste exacte des numéros manquants (rattrapage ciblé, pas de resync
 * aveugle). Un doublon → ignoré explicitement.
 */
export class RecepteurEvenements {
  private attendus = new Map<string, number>();

  constructor(private demarrage = 1) {}

  recevoir(evenement: EvenementNumerote): DiagnosticReception {
    const attendu = this.attendus.get(evenement.sessionId) ?? this.demarrage;
    this.attendus.set(evenement.sessionId, attendu);
    if (evenement.sequence === attendu) {
      this.attendus.set(evenement.sessionId, attendu + 1);
      return { etat: "en-ordre", attendu, recu: evenement.sequence };
    }
    if (evenement.sequence < attendu) {
      return { etat: "doublon", attendu, recu: evenement.sequence };
    }
    const manquants: number[] = [];
    for (let n = attendu; n < evenement.sequence; n++) manquants.push(n);
    // L'événement recu est accepté ; les manquants sont demandés au rattrapage.
    this.attendus.set(evenement.sessionId, evenement.sequence + 1);
    return { etat: "trou-detected", attendu, recu: evenement.sequence, manquants };
  }
}

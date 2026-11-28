/**
 * GESTIONNAIRE D'ONDES UNIFIÉES — un champ de fusion PAR UTILISATEUR.
 *
 * Même doctrine P0 que l'hippocampe durci (fenêtres par utilisateur,
 * éviction LRU au-delà de la limite) : les ondes d'un utilisateur ne
 * résonnent JAMAIS avec celles d'un autre — la fusion neurones+mémoire
 * préserve l'isolement multi-comptes. Les clés sont les tuples JSON
 * (userId, conversationId) produits par NeuralEngine.memoirePour().
 */

import { NoeudOndesUnifie } from "./noeud-ondes-unifie";

/** Plafond de champs vivants — aligné sur LIMITE_FENETRES_MEMOIRE du moteur. */
export const LIMITE_CHAMPS = 500;

export interface StatistiquesGestionnaire {
  champsVivants: number;
  limite: number;
  dernierAccesMs: number;
}

interface EntreeChamp {
  noeud: NoeudOndesUnifie;
  dernierAcces: number;
}

export class GestionnaireOndesUnifie {
  private champs = new Map<string, EntreeChamp>();

  constructor(private readonly limite = LIMITE_CHAMPS) {}

  /** Champ de fusion pour une clé utilisateur|conversation (créé au besoin). */
  noeudPour(cle: string): NoeudOndesUnifie {
    const existant = this.champs.get(cle);
    if (existant) {
      existant.dernierAcces = Date.now();
      return existant.noeud;
    }
    if (this.champs.size >= this.limite) {
      // Éviction LRU — la mémoire d'ondes longue des comptes inactifs cède.
      let clePlusAncienne: string | null = null;
      let plusAncien = Number.POSITIVE_INFINITY;
      for (const [cleExistante, valeur] of this.champs) {
        if (valeur.dernierAcces < plusAncien) {
          plusAncien = valeur.dernierAcces;
          clePlusAncienne = cleExistante;
        }
      }
      if (clePlusAncienne) this.champs.delete(clePlusAncienne);
    }
    const noeud = new NoeudOndesUnifie(cle);
    this.champs.set(cle, { noeud, dernierAcces: Date.now() });
    return noeud;
  }

  statistiques(): StatistiquesGestionnaire {
    let dernierAccesMs = 0;
    for (const valeur of this.champs.values()) {
      if (valeur.dernierAcces > dernierAccesMs) dernierAccesMs = valeur.dernierAcces;
    }
    return { champsVivants: this.champs.size, limite: this.limite, dernierAccesMs };
  }
}

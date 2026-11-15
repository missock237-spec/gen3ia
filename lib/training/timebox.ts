/**
 * TIMEBOX D'ENTRAÎNEMENT — « un entraînement de modèle utilisateur ne
 * dure JAMAIS plus de trente minutes, par modèle, par session ».
 *
 * Garantie forte appliquée à TROIS niveaux (défense en profondeur) :
 *
 *  1. DEADLINE dans la boucle physique : `EntrainementParResonance.
 *     entrainer()` vérifie l'horloge entre chaque round et s'arrête
 *     PROPREMENT (l'état de l'élève reste cohérent et archivable) ;
 *  2. VERROU d'entraînement (lib/training/verrou.ts) : un seul
 *     entraînement actif par modèle — le verrou porte le TTL de la
 *     timebox : même un crash serveur libère le modèle au plus tard
 *     à l'expiration du verrou ;
 *  3. PLAFOND à l'entrée : toute durée demandée est bornée à la
 *     constante ci-dessous, sans exception ni configuration possible
 *     pour la dépasser (c'est la GARANTIE produit affichée).
 */

/** Durée maximale d'un entraînement : 30 minutes, par modèle, par session. */
export const DUREE_MAX_ENTRAINEMENT_MS = 30 * 60 * 1000;

/** Marge du verrou au-delà de la timebox (nettoyage, archivage final). */
export const MARGE_VERROU_MS = 5 * 60 * 1000;

export interface StatutTimebox {
  /** Budget total accordé (ms). */
  budgetMs: number;
  /** Temps consommé (ms). */
  consommeMs: number;
  /** Temps restant (ms) — peut être négatif si la deadline est passée. */
  resteMs: number;
  /** La deadline est atteinte ou dépassée. */
  depasse: boolean;
}

/** Crée la deadline d'une session d'entraînement (budget borné à 30 min). */
export function creerDeadline(debutMs = Date.now()): { deadlineMs: number; budgetMs: number } {
  const budgetMs = DUREE_MAX_ENTRAINEMENT_MS;
  return { deadlineMs: debutMs + budgetMs, budgetMs };
}

/** Statut d'une deadline à l'instant t. */
export function statutTimebox(deadlineMs: number, maintenant: () => number = Date.now): StatutTimebox {
  const consommeMs = Math.max(0, maintenant() - (deadlineMs - DUREE_MAX_ENTRAINEMENT_MS));
  const resteMs = deadlineMs - maintenant();
  return { budgetMs: DUREE_MAX_ENTRAINEMENT_MS, consommeMs, resteMs, depasse: resteMs <= 0 };
}

/** Bornage défensif d'une durée demandée par l'appelant (≤ 30 min, ≥ 1 s). */
export function bornerBudgetMs(demandeMs?: number): number {
  if (typeof demandeMs !== "number" || !Number.isFinite(demandeMs)) return DUREE_MAX_ENTRAINEMENT_MS;
  return Math.min(DUREE_MAX_ENTRAINEMENT_MS, Math.max(1000, Math.floor(demandeMs)));
}

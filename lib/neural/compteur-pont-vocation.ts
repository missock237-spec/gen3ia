/**
 * COMPTEUR DU PONT VOCATION (it.75 — complément de la vue utilisateur de la
 * sobriété, candidat №2 déclaré it.74 §7 : la mesure devient visible sans
 * curl ET COMPLÈTE).
 *
 * Pourquoi ce compteur : la sobriété réelle de gen3 a DEUX périmètres
 * disjoints, tous deux mesurés — jamais estimés :
 *  1. LE MOTEUR (compteur it.74, /api/energie → compteur) : les fenêtres
 *     neuronales exécutées vs évitées par le court-circuit éco (chemin
 *     chat / génération) ;
 *  2. LE PONT PUBLIC (ce compteur, /api/energie → pontVocation) : les
 *     questions du cadre servies par l'endpoint public /api/neural/questions
 *     (testeur /vocation it.66) — cet endpoint répond par le pont vocation
 *     SANS JAMAIS allumer de fenêtre moteur, PAR CONSTRUCTION, quel que
 *     soit le profil (c'est le maximum de sobriété : zéro fenêtre, zéro
 *     RPIA, zéro cycle) ; une question hors cadre y reçoit un refus honnête
 *     (la chaîne classique n'est PAS appelée par cet endpoint).
 *
 * Chaque champ est une SOMME D'ENTIERS MESURÉS — jamais une estimation ni
 * un contre-factuel inventé : on compte ce qui est arrivé, pas ce qui
 * « aurait pu » arriver. Persistance : en MÉMOIRE du processus (globalThis,
 * même convention que le compteur it.74) — réinitialisé à chaque
 * redéploiement, limite déclarée dans la réponse de /api/energie.
 */

/** Clé du compteur sur globalThis (survit aux recharges de module). */
export const CLE_COMPTEUR_PONT = "__gen3CompteurPontVocationIt75";

/** État cumulé mesuré (tous champs sommes d'entiers — jamais estimés). */
export interface CompteurPontVocation {
  /** Questions du cadre RÉPONDUES par le pont (sans fenêtre moteur). */
  readonly reponsesServies: number;
  /** Questions hors cadre → REFUS honnête (aucune réponse fabriquée). */
  readonly refusHonnêtes: number;
  /** ISO du démarrage du compteur (= démarrage du processus). */
  readonly demarrageIso: string;
}

interface CompteurMutable {
  reponsesServies: number;
  refusHonnêtes: number;
  demarrageIso: string;
}

function conteneur(): CompteurMutable {
  const global = globalThis as unknown as Record<string, unknown>;
  const existant = global[CLE_COMPTEUR_PONT] as CompteurMutable | undefined;
  if (existant) return existant;
  const neuf: CompteurMutable = {
    reponsesServies: 0,
    refusHonnêtes: 0,
    demarrageIso: new Date().toISOString(),
  };
  global[CLE_COMPTEUR_PONT] = neuf;
  return neuf;
}

/**
 * Enregistre une question du cadre RÉPONDUE par le pont public — réponse
 * servie SANS fenêtre moteur (construction de l'endpoint, tout profil).
 */
export function enregistrerReponsePont(): void {
  conteneur().reponsesServies += 1;
}

/** Enregistre un REFUS honnête hors cadre (aucune réponse fabriquée). */
export function enregistrerRefusPont(): void {
  conteneur().refusHonnêtes += 1;
}

/** Lecture (copie défensive) du compteur cumulé du pont. */
export function lireCompteurPontVocation(): CompteurPontVocation {
  const c = conteneur();
  return {
    reponsesServies: c.reponsesServies,
    refusHonnêtes: c.refusHonnêtes,
    demarrageIso: c.demarrageIso,
  };
}

/** Réinitialisation (usage : garde/tests — jamais en production). */
export function reinitialiserCompteurPontVocation(): void {
  const global = globalThis as unknown as Record<string, unknown>;
  delete global[CLE_COMPTEUR_PONT];
}

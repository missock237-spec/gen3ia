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
 * « aurait pu » arriver.
 *
 * Persistance (it.78) : en MÉMOIRE du processus (globalThis, même
 * convention que le compteur it.74) ET sur disque (var/neural/
 * compteurs-energie.json, écriture atomique via persistance-compteurs.ts)
 * — les sommes CONTINUENT à travers les redéploiements et l'ORIGINE de la
 * mesure (origineIso) survit. Si l'écriture disque est impossible, le
 * compteur continue en mémoire seule et ce repli est DÉCLARÉ par
 * /api/energie (mode « memoire ») — jamais silencieux.
 */

import {
  lireEtatCompteurs,
  persisterBlocCompteur,
  effacerEtatCompteurs,
} from "@/lib/neural/persistance-compteurs";

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
  // it.78 — AMORÇAGE depuis le disque : la somme cumulée continue après un
  // redéploiement (fichier absent/corrompu → zéro honnête, jamais d'estimation).
  const persiste = lireEtatCompteurs();
  const origineIso = persiste?.origineIso ?? new Date().toISOString();
  const neuf: CompteurMutable = {
    reponsesServies: persiste?.pont?.reponsesServies ?? 0,
    refusHonnêtes: persiste?.pont?.refusHonnêtes ?? 0,
    demarrageIso: origineIso,
  };
  global[CLE_COMPTEUR_PONT] = neuf;
  persisterBlocCompteur("pont", {
    reponsesServies: neuf.reponsesServies,
    refusHonnêtes: neuf.refusHonnêtes,
  }, origineIso);
  return neuf;
}

function persister(): void {
  const c = conteneur();
  persisterBlocCompteur("pont", {
    reponsesServies: c.reponsesServies,
    refusHonnêtes: c.refusHonnêtes,
  }, c.demarrageIso);
}

/**
 * Enregistre une question du cadre RÉPONDUE par le pont public — réponse
 * servie SANS fenêtre moteur (construction de l'endpoint, tout profil).
 */
export function enregistrerReponsePont(): void {
  conteneur().reponsesServies += 1;
  persister();
}

/** Enregistre un REFUS honnête hors cadre (aucune réponse fabriquée). */
export function enregistrerRefusPont(): void {
  conteneur().refusHonnêtes += 1;
  persister();
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

/**
 * Réinitialisation (usage : garde/tests — jamais en production) : remet le
 * conteneur en mémoire ET le fichier de persistance à zéro — un test
 * redémarre toujours d'un état honnêtement vide.
 */
export function reinitialiserCompteurPontVocation(): void {
  const global = globalThis as unknown as Record<string, unknown>;
  delete global[CLE_COMPTEUR_PONT];
  effacerEtatCompteurs();
}

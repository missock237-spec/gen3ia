/**
 * COMPTEUR D'ÉNERGIE DU PROCESSUS (it.74 — mesure RÉELLE de la réduction
 * de charge serveur, candidat №1 déclaré it.73 §7.1 : « mesurer la
 * réduction réelle de la charge serveur (fenêtres évitées comptées dans
 * les télémétries) »).
 *
 * Chaque champ est une SOMME D'ENTIERS MESURÉS — jamais une estimation :
 *  - fenetresExecutees  : une fenêtre neuronale complète a tourné
 *                         (RPIA + cycles — chemins historiques) ;
 *  - fenetresEvitees    : le court-circuit éco a répondu SANS fenêtre
 *                         (profil eco/telephone — même texte, garde A/B) ;
 *  - epoquesRPIAEvitees / cyclesNoyauEvites : travail neuronal que les
 *                         fenêtres évitées n'ont PAS exécuté (12 époques
 *                         RPIA + 4 cycles par fenêtre évitée, constantes
 *                         du moteur déclarées par la garde 42ᵉ).
 *
 * Persistance : en MÉMOIRE du processus (globalThis) — honnêteté : le
 * compteur couvre « depuis le démarrage du processus », il est réinitialisé
 * à chaque redéploiement (swap atomique + rechargement PM2). Il est exposé
 * publiquement par /api/energie avec cette limite déclarée.
 */

/** Clé du compteur sur globalThis (survit aux recharges de module). */
export const CLE_COMPTEUR_ENERGIE = "__gen3CompteurEnergieIt74";

/** État cumulé mesuré (tous champs sommes d'entiers — jamais estimés). */
export interface CompteurEnergieProcess {
  /** Fenêtres neuronales complètes exécutées depuis le démarrage. */
  readonly fenetresExecutees: number;
  /** Fenêtres évitées par le court-circuit éco (même texte, zéro fenêtre). */
  readonly fenetresEvitees: number;
  /** Époques RPIA non exécutées grâce aux fenêtres évitées. */
  readonly epoquesRPIAEvitees: number;
  /** Cycles du noyau non exécutés grâce aux fenêtres évitées. */
  readonly cyclesNoyauEvites: number;
  /** ISO du démarrage du compteur (= démarrage du processus). */
  readonly demarrageIso: string;
}

interface CompteurMutable {
  fenetresExecutees: number;
  fenetresEvitees: number;
  epoquesRPIAEvitees: number;
  cyclesNoyauEvites: number;
  demarrageIso: string;
}

function conteneur(): CompteurMutable {
  const global = globalThis as unknown as Record<string, unknown>;
  const existant = global[CLE_COMPTEUR_ENERGIE] as CompteurMutable | undefined;
  if (existant) return existant;
  const neuf: CompteurMutable = {
    fenetresExecutees: 0,
    fenetresEvitees: 0,
    epoquesRPIAEvitees: 0,
    cyclesNoyauEvites: 0,
    demarrageIso: new Date().toISOString(),
  };
  global[CLE_COMPTEUR_ENERGIE] = neuf;
  return neuf;
}

/**
 * Enregistre une fenêtre évitée par le court-circuit éco (profil eco /
 * telephone) : le travail neuronal déclaré (12 époques RPIA + 4 cycles)
 * n'a PAS été exécuté.
 */
export function enregistrerFenetreEvitee(
  epoquesRPIA: number,
  cyclesNoyau: number,
): void {
  const c = conteneur();
  c.fenetresEvitees += 1;
  c.epoquesRPIAEvitees += epoquesRPIA;
  c.cyclesNoyauEvites += cyclesNoyau;
}

/** Enregistre une fenêtre neuronale complète exécutée (chemin historique). */
export function enregistrerFenetreExecutee(): void {
  conteneur().fenetresExecutees += 1;
}

/** Lecture (copie défensive) du compteur cumulé du processus. */
export function lireCompteurEnergieProcess(): CompteurEnergieProcess {
  const c = conteneur();
  return {
    fenetresExecutees: c.fenetresExecutees,
    fenetresEvitees: c.fenetresEvitees,
    epoquesRPIAEvitees: c.epoquesRPIAEvitees,
    cyclesNoyauEvites: c.cyclesNoyauEvites,
    demarrageIso: c.demarrageIso,
  };
}

/** Réinitialisation (usage : garde/tests — jamais en production). */
export function reinitialiserCompteurEnergieProcess(): void {
  const global = globalThis as unknown as Record<string, unknown>;
  delete global[CLE_COMPTEUR_ENERGIE];
}

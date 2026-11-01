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
 * Persistance (it.78) : en MÉMOIRE du processus (globalThis) ET sur disque
 * (var/neural/compteurs-energie.json, écriture atomique via
 * persistance-compteurs.ts) — la somme cumulée et son ORIGINE (origineIso)
 * CONTINUENT à travers les redéploiements (swap atomique + rechargement
 * PM2) ; la limite historique « remise à zéro à chaque redéploiement » est
 * levée. Si l'écriture disque est impossible, le compteur continue en
 * mémoire seule et ce repli est DÉCLARÉ publiquement par /api/energie
 * (mode « memoire ») — jamais silencieux. Il est exposé publiquement par
 * /api/energie.
 */

import {
  lireEtatCompteurs,
  persisterBlocCompteur,
  effacerEtatCompteurs,
} from "@/lib/neural/persistance-compteurs";

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
  // it.78 — AMORÇAGE depuis le disque : la somme cumulée continue après un
  // redéploiement (fichier absent/corrompu → zéro honnête, jamais d'estimation).
  const persiste = lireEtatCompteurs();
  const origineIso = persiste?.origineIso ?? new Date().toISOString();
  const neuf: CompteurMutable = {
    fenetresExecutees: persiste?.moteur?.fenetresExecutees ?? 0,
    fenetresEvitees: persiste?.moteur?.fenetresEvitees ?? 0,
    epoquesRPIAEvitees: persiste?.moteur?.epoquesRPIAEvitees ?? 0,
    cyclesNoyauEvites: persiste?.moteur?.cyclesNoyauEvites ?? 0,
    demarrageIso: origineIso,
  };
  global[CLE_COMPTEUR_ENERGIE] = neuf;
  persisterBlocCompteur("moteur", {
    fenetresExecutees: neuf.fenetresExecutees,
    fenetresEvitees: neuf.fenetresEvitees,
    epoquesRPIAEvitees: neuf.epoquesRPIAEvitees,
    cyclesNoyauEvites: neuf.cyclesNoyauEvites,
  }, origineIso);
  return neuf;
}

function persister(): void {
  const c = conteneur();
  persisterBlocCompteur("moteur", {
    fenetresExecutees: c.fenetresExecutees,
    fenetresEvitees: c.fenetresEvitees,
    epoquesRPIAEvitees: c.epoquesRPIAEvitees,
    cyclesNoyauEvites: c.cyclesNoyauEvites,
  }, c.demarrageIso);
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
  persister();
}

/** Enregistre une fenêtre neuronale complète exécutée (chemin historique). */
export function enregistrerFenetreExecutee(): void {
  conteneur().fenetresExecutees += 1;
  persister();
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

/**
 * Réinitialisation (usage : garde/tests — jamais en production) : remet le
 * conteneur en mémoire ET le fichier de persistance à zéro — un test
 * redémarre toujours d'un état honnêtement vide.
 */
export function reinitialiserCompteurEnergieProcess(): void {
  const global = globalThis as unknown as Record<string, unknown>;
  delete global[CLE_COMPTEUR_ENERGIE];
  effacerEtatCompteurs();
}

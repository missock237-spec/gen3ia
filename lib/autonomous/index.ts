/**
 * ARMEMENT DU GEN3IA AUTONOMOUS CORE AU BOOT (Phase 1).
 *
 * Point d'entrée appelé par `instrumentation.ts` (hook nodejs) — même
 * convention que `demarrerAutoApprentissage()` :
 *  - import dynamique (le module n'est chargé que quand le serveur tourne) ;
 *  - désactivable par AUTO_CORE=0 ;
 *  - AUCUN échec ici ne peut empêcher le démarrage du serveur (fail-soft) ;
 *  - le core supervise des MODULES-AGENTS (contrat ModuleAgent) : chaque
 *    phase du plan s'ajoute ici, jamais à côté.
 *
 * Premiers agents enregistrés (Phase 1) :
 *  - sante-cerveau : fraîcheur réelle de la persistance du cerveau
 *    (trou n°5 de l'audit Phase 0).
 */

import "server-only";

import { getCoeurAutonome } from "./core/orchestrator";
import { chargerConfigCoeurAutonome } from "./core/config/autonomous-config";

/** Résultat honnête de l'armement. */
export interface ResultatArmement {
  arme: boolean;
  dejaDemarre: boolean;
  modulesEnregistres: string[];
  tachesReprises: number;
  message: string;
}

/**
 * Arme le cœur autonome et enregistre les modules-agents de cette phase.
 * Fail-soft : retourne toujours un résultat honnête, ne lève jamais.
 */
export async function demarrerCoeurAutonome(): Promise<ResultatArmement> {
  const config = chargerConfigCoeurAutonome();
  if (!config.arme) {
    return {
      arme: false,
      dejaDemarre: false,
      modulesEnregistres: [],
      tachesReprises: 0,
      message: "AUTO_CORE=0 — cœur autonome désactivé par configuration.",
    };
  }
  try {
    const { agentSanteCerveau } = await import("./modules/agent-sante-cerveau");
    const coeur = getCoeurAutonome({ config });
    coeur.enregistrerModule(agentSanteCerveau());
    const reprise = coeur.demarrer();
    return {
      arme: true,
      dejaDemarre: reprise.dejaDemarre,
      modulesEnregistres: ["sante-cerveau"],
      tachesReprises: reprise.tachesReprises,
      message: reprise.dejaDemarre
        ? "Cœur autonome déjà actif (idempotent)."
        : `Cœur autonome armé (cycle 5 min) — ${reprise.tachesReprises} tâche(s) interrompue(s) reprise(s) de l'état persisté.`,
    };
  } catch (erreur) {
    return {
      arme: false,
      dejaDemarre: false,
      modulesEnregistres: [],
      tachesReprises: 0,
      message: `Armement du cœur autonome échoué (non fatal) : ${erreur instanceof Error ? erreur.message : String(erreur)}`,
    };
  }
}

/** Arrêt propre (utilisée par les tests et un futur signal de shutdown). */
export function arreterCoeurAutonome(): boolean {
  const coeur = getCoeurAutonome();
  const etaitActif = coeur.actif();
  coeur.arreter();
  return etaitActif;
}

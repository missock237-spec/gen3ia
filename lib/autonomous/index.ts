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
    const modules: string[] = ["sante-cerveau"];
    coeur.enregistrerModule(agentSanteCerveau());

    // LOT 2-5 (collecteur + pipeline) : armés par défaut (cycles 5 min du
    // plan), désactivables par AUTO_COLLECTE=0 (collecte légère possible).
    if (process.env.AUTO_COLLECTE !== "0") {
      const { agentCollecteur } = await import("./acquisition/collecteur");
      const { agentTraitement } = await import("./pipeline/worker");
      const { RegistreSources } = await import("./acquisition/source-registry");
      const { FileLots } = await import("./pipeline/queue");
      const { MemoireConnaissances } = await import("./knowledge/memoire-connaissances");
      const dossier = coeur.dossierEtat();
      const registre = new RegistreSources(dossier);
      const file = new FileLots(dossier);
      const memoire = new MemoireConnaissances(dossier);
      coeur.enregistrerModule(agentCollecteur({ registre, file }));
      coeur.enregistrerModule(agentTraitement({ file, memoire, registre, dossierCore: dossier }));
      modules.push("acquisition", "traitement");

      // LOT 5+6 (mission finalisation) : apprentissage continu branché au
      // cerveau RÉEL (adaptations seulement si réellement prises en charge,
      // pré/post + garde anti-oubli) + compétences en sandbox isolée.
      if (process.env.AUTO_CONTINU !== "0") {
        const { agentApprentissageContinu } = await import("./modules/agent-apprentissage");
        coeur.enregistrerModule(agentApprentissageContinu({ memoire, tousLesCycles: 4 }));
        modules.push("apprentissage-continu");
      }
      if (process.env.AUTO_SKILLS !== "0") {
        const { agentCompetences } = await import("./modules/agent-competences");
        coeur.enregistrerModule(agentCompetences({ memoire, dossierCore: dossier, tousLesCycles: 6 }));
        modules.push("competences");
      }
    }

    const reprise = coeur.demarrer();
    return {
      arme: true,
      dejaDemarre: reprise.dejaDemarre,
      modulesEnregistres: modules,
      tachesReprises: reprise.tachesReprises,
      message: reprise.dejaDemarre
        ? "Cœur autonome déjà actif (idempotent)."
        : `Cœur autonome armé — modules : ${modules.join(", ")} (cycle 5 min) — ${reprise.tachesReprises} tâche(s) interrompue(s) reprise(s) de l'état persisté.`,
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
